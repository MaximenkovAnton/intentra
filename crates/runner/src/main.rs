use std::path::PathBuf;

use clap::{Parser, Subcommand};
use intentra_runner_core::daemon::{McpServer, Registry};
use intentra_runner_core::job::{ExecutorConfig, JobManager};
use intentra_runner_core::state::RunnerState;
use intentra_runner_core::transport::{self, ClientConfig};
use intentra_runner_core::update::apply::{
    ApplyRequest, ProcessRestarter, ReconcileRequest, SelfReplaceInstaller, apply_release,
    reconcile_pending, report_outcome,
};
use intentra_runner_core::update::client::UpdateClient;
use intentra_runner_core::update::daemon::{self as update_daemon, UpdateDaemon};
use intentra_runner_core::update::sanitize_for_log;
use intentra_runner_core::update::state::UpdateState;
use intentra_runner_core::{
    EXIT_AUTH, EXIT_CONFIG, EXIT_FAILURE, EXIT_NOT_RUNNING, EXIT_OK, config, mcp, register, token,
    util,
};
use tokio::sync::watch;
use tracing_subscriber::EnvFilter;

#[derive(Parser)]
#[command(
    name = "intentra-runner",
    version = intentra_runner_core::version(),
    about = "Intentra runner: outgoing WSS client, git worktrees, local index, MCP stdio"
)]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// Register this machine with the control plane and store the runner token.
    Register {
        /// Control-plane URL (https:// or wss://).
        #[arg(long)]
        server: String,
        /// One-time registration token issued by the control plane.
        #[arg(long)]
        token: String,
        /// Runner display name.
        #[arg(long)]
        name: String,
        /// Config file used to locate the token path.
        #[arg(long)]
        config: Option<PathBuf>,
    },
    /// Connect to the control plane and accept jobs.
    Start {
        #[arg(long)]
        config: Option<PathBuf>,
    },
    /// Report whether the daemon is running from its state file.
    Status {
        #[arg(long)]
        config: Option<PathBuf>,
    },
    /// Check config, token permissions, git and workspaces.
    Doctor {
        #[arg(long)]
        config: Option<PathBuf>,
    },
    /// Serve the Intentra MCP tools for one job over stdio.
    Mcp {
        #[arg(long)]
        job: String,
        /// Loopback address of the runner daemon MCP listener.
        #[arg(long)]
        socket: String,
    },
    /// Check the center for a newer runner release, or install it.
    Update {
        /// Install the release instead of only reporting it.
        #[arg(long)]
        apply: bool,
        #[arg(long)]
        config: Option<PathBuf>,
    },
}

fn default_config_path() -> PathBuf {
    std::env::var_os("INTENTRA_CONFIG")
        .map(PathBuf::from)
        .unwrap_or_else(|| util::expand_tilde("~/.intentra/config.toml"))
}

fn load_config(flag: Option<PathBuf>) -> Result<(config::Config, PathBuf), i32> {
    let path = flag.unwrap_or_else(default_config_path);
    match config::Config::load(&path) {
        Ok(config) => Ok((config, path)),
        Err(error) => {
            eprintln!("config: {error}");
            Err(EXIT_CONFIG)
        }
    }
}

fn init_tracing(level: &str) {
    let filter = EnvFilter::try_from_default_env()
        .or_else(|_| EnvFilter::try_new(level))
        .unwrap_or_else(|_| EnvFilter::new("info"));
    let _ = tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_target(false)
        .try_init();
}

fn spawn_shutdown(sender: watch::Sender<bool>) {
    tokio::spawn(async move {
        #[cfg(unix)]
        {
            use tokio::signal::unix::{SignalKind, signal};
            let mut terminate = match signal(SignalKind::terminate()) {
                Ok(terminate) => terminate,
                Err(_) => {
                    let _ = tokio::signal::ctrl_c().await;
                    let _ = sender.send(true);
                    return;
                }
            };
            tokio::select! {
                _ = tokio::signal::ctrl_c() => {}
                _ = terminate.recv() => {}
            }
        }
        #[cfg(not(unix))]
        {
            let _ = tokio::signal::ctrl_c().await;
        }
        let _ = sender.send(true);
    });
}

async fn command_register(
    server: String,
    registration_token: String,
    name: String,
    config_flag: Option<PathBuf>,
) -> i32 {
    let token_path = match config_flag {
        Some(path) => match config::Config::load(&path) {
            Ok(config) => config.token_path(),
            Err(error) => {
                eprintln!("config: {error}");
                return EXIT_CONFIG;
            }
        },
        None => register::default_token_path(),
    };
    match register::register(&server, &registration_token, &name, &token_path).await {
        Ok(stored) => {
            println!(
                "{}",
                serde_json::json!({
                    "runnerId": stored.runner_id,
                    "tokenPath": token_path.display().to_string(),
                })
            );
            EXIT_OK
        }
        Err(error) => {
            eprintln!("register: {error}");
            EXIT_FAILURE
        }
    }
}

async fn command_start(config_flag: Option<PathBuf>) -> i32 {
    let (config, config_path) = match load_config(config_flag) {
        Ok(loaded) => loaded,
        Err(code) => return code,
    };
    init_tracing(&config.log_level);
    let token_path = config.token_path();
    let stored = match token::load(&token_path) {
        Ok(stored) => stored,
        Err(error) => {
            eprintln!("token: {error}; run `intentra-runner register` first");
            return EXIT_AUTH;
        }
    };
    let state_dir = config.state_dir();
    let version = intentra_runner_core::version();
    let installer = SelfReplaceInstaller;
    let restarter = ProcessRestarter::new(state_dir.clone());
    let update_client = UpdateClient::new(
        &config.server_url,
        &stored.token,
        config.update.allow_insecure_http,
    );
    if let Err(error) = &update_client {
        tracing::warn!(error = %error, "cannot build the update client");
    }
    let update_client = update_client.ok();
    reconcile_pending(&ReconcileRequest {
        state_dir: &state_dir,
        current_version: version,
        config_path: &config_path,
        token_path: &token_path,
        installer: &installer,
        restarter: &restarter,
        client: update_client.as_ref(),
    })
    .await;
    let registry = Registry::new();
    let mcp_server = match McpServer::bind(std::sync::Arc::clone(&registry)).await {
        Ok(server) => std::sync::Arc::new(server),
        Err(error) => {
            eprintln!("mcp listener: {error}");
            return EXIT_FAILURE;
        }
    };
    let mcp_endpoint = mcp_server.endpoint();
    let state = RunnerState::new(&config.server_url, &mcp_endpoint);
    if let Err(error) = state.write(&state_dir) {
        eprintln!("state file: {error}");
        return EXIT_FAILURE;
    }
    let host =
        intentra_runner_core::adapters::host::RunnerHost::new(std::sync::Arc::clone(&registry));
    let adapters = intentra_runner_core::adapters::from_config(&config, host.clone()).await;
    if adapters.is_empty() {
        tracing::warn!("no runtime adapters are configured; job offers will be declined");
    }
    let adapter_infos = adapters.infos();
    let workspaces = config
        .workspaces
        .iter()
        .map(|(key, path)| (key.clone(), util::expand_tilde(path)))
        .collect();
    let jobs = JobManager::new(
        ExecutorConfig {
            roots: config.roots(),
            workspaces,
            max_concurrent_jobs: config.max_concurrent_jobs,
        },
        adapters,
        mcp_server,
        host,
    );
    let mut client = ClientConfig::new(
        config.server_url.clone(),
        stored.token.clone(),
        config
            .workspaces
            .values()
            .map(|path| util::expand_tilde(path).display().to_string())
            .collect(),
        adapter_infos,
    );
    client.token_path = Some(token_path);
    client.runner_id = stored.runner_id;
    let (shutdown_tx, shutdown_rx) = watch::channel(false);
    spawn_shutdown(shutdown_tx);
    let pending_update = UpdateState::load(&state_dir)
        .ok()
        .flatten()
        .and_then(|state| state.pending)
        .is_some();
    if (config.update.enabled || pending_update)
        && let Some(update_client) = update_client
    {
        let (hello_tx, hello_rx) = watch::channel(false);
        client.hello = Some(hello_tx);
        let daemon = std::sync::Arc::new(UpdateDaemon {
            client: update_client,
            update: config.update.clone(),
            current_version: version.to_string(),
            state_dir: state_dir.clone(),
            jobs: std::sync::Arc::clone(&jobs),
            installer: std::sync::Arc::new(SelfReplaceInstaller),
            restarter: std::sync::Arc::new(ProcessRestarter::new(state_dir.clone())),
            waiting_for_hello: None,
        });
        tokio::spawn(update_daemon::run(daemon, hello_rx, shutdown_rx.clone()));
    }
    tracing::info!(
        server = %config.server_url,
        mcp = %mcp_endpoint,
        "intentra runner started"
    );
    let result = transport::run(client, jobs, shutdown_rx).await;
    RunnerState::remove(&state_dir);
    match result {
        Ok(()) => EXIT_OK,
        Err(error) => {
            tracing::error!(error = %error, "runner stopped with an error");
            EXIT_FAILURE
        }
    }
}

fn command_status(config_flag: Option<PathBuf>) -> i32 {
    let (config, _config_path) = match load_config(config_flag) {
        Ok(loaded) => loaded,
        Err(code) => return code,
    };
    let state_dir = config.state_dir();
    let state = match RunnerState::read(&state_dir) {
        Ok(state) => state,
        Err(_) => {
            println!(
                "{}",
                serde_json::json!({"running": false, "stateDir": state_dir.display().to_string()})
            );
            return EXIT_NOT_RUNNING;
        }
    };
    let token_state = match token::load(&config.token_path()) {
        Ok(_) => "present",
        Err(error) => {
            println!(
                "{}",
                serde_json::json!({
                    "running": false,
                    "stateDir": state_dir.display().to_string(),
                    "token": error.to_string(),
                })
            );
            return EXIT_AUTH;
        }
    };
    println!(
        "{}",
        serde_json::json!({
            "running": true,
            "version": state.version,
            "pid": state.pid,
            "startedAt": state.started_at,
            "serverUrl": state.server_url,
            "mcpAddr": state.mcp_addr,
            "token": token_state,
        })
    );
    EXIT_OK
}

fn command_doctor(config_flag: Option<PathBuf>) -> i32 {
    let (config, _config_path) = match load_config(config_flag) {
        Ok(loaded) => loaded,
        Err(code) => return code,
    };
    let mut failures = 0;
    let report = |ok: bool, name: &str, detail: String| {
        println!("{} {name}: {detail}", if ok { "ok  " } else { "FAIL" });
        !ok
    };
    failures += usize::from(report(
        util::is_valid_ws_url(&config.server_url),
        "server_url",
        config.server_url.clone(),
    ));
    failures += usize::from(report(
        config.max_concurrent_jobs >= 1,
        "max_concurrent_jobs",
        config.max_concurrent_jobs.to_string(),
    ));
    let token_path = config.token_path();
    match token::load(&token_path) {
        Ok(stored) => {
            println!(
                "ok   token: {} (runner {})",
                token_path.display(),
                stored.runner_id.as_deref().unwrap_or("unknown")
            );
        }
        Err(error) => {
            failures += 1;
            println!("FAIL token: {error}");
        }
    }
    match std::process::Command::new("git").arg("--version").output() {
        Ok(output) if output.status.success() => println!(
            "ok   git: {}",
            String::from_utf8_lossy(&output.stdout).trim()
        ),
        _ => {
            failures += 1;
            println!("FAIL git: the git CLI is required");
        }
    }
    let roots = config.roots();
    for root in &config.allow_roots {
        let path = util::expand_tilde(root);
        failures += usize::from(report(
            path.is_dir(),
            "allow_root",
            path.display().to_string(),
        ));
    }
    for (key, path) in &config.workspaces {
        let path = util::expand_tilde(path);
        match std::fs::canonicalize(&path) {
            Ok(canonical) if util::inside_roots(&canonical, &roots) => {
                println!("ok   workspace {key}: {}", canonical.display());
            }
            Ok(canonical) => {
                failures += 1;
                println!(
                    "FAIL workspace {key}: {} is outside allow_roots",
                    canonical.display()
                );
            }
            Err(error) => {
                failures += 1;
                println!("FAIL workspace {key}: {error}");
            }
        }
    }
    if let Ok(state) = RunnerState::read(&config.state_dir()) {
        println!(
            "ok   daemon: pid {} since {} on {}",
            state.pid, state.started_at, state.server_url
        );
        failures += usize::from(report(true, "mcp", state.mcp_addr));
    } else {
        println!("warn daemon: not running (no state file)");
    }
    if failures == 0 { EXIT_OK } else { EXIT_FAILURE }
}

async fn command_update(apply: bool, config_flag: Option<PathBuf>) -> i32 {
    let (config, _config_path) = match load_config(config_flag) {
        Ok(loaded) => loaded,
        Err(code) => return code,
    };
    let token_path = config.token_path();
    let stored = match token::load(&token_path) {
        Ok(stored) => stored,
        Err(error) => {
            eprintln!("token: {error}; run `intentra-runner register` first");
            return EXIT_AUTH;
        }
    };
    let state_dir = config.state_dir();
    if apply && RunnerState::read(&state_dir).is_ok() {
        eprintln!("update: daemon is running; stop it before applying an update");
        return EXIT_FAILURE;
    }
    let version = intentra_runner_core::version();
    let client = match UpdateClient::new(
        &config.server_url,
        stored.token,
        config.update.allow_insecure_http,
    ) {
        Ok(client) => client,
        Err(error) => {
            eprintln!("update: {error}");
            return EXIT_FAILURE;
        }
    };
    let update = match client.update(version, config.update.channel).await {
        Ok(update) => update,
        Err(error) => {
            eprintln!("update: {error}");
            return EXIT_FAILURE;
        }
    };
    if !apply {
        println!(
            "{}",
            serde_json::json!({
                "current": version,
                "latest": update.latest_version,
                "channel": config.update.channel.as_str(),
                "available": update.available,
                "pinnedVersion": update.pinned_version,
                "autoUpdate": update.auto_update,
                "reason": update.reason,
            })
        );
        return EXIT_OK;
    }
    if !update.available {
        println!(
            "{}",
            serde_json::json!({"current": version, "available": false})
        );
        return EXIT_OK;
    }
    if let Some(reason) = update.apply_blocker() {
        eprintln!("update: {reason}");
        return EXIT_FAILURE;
    }
    let installer = SelfReplaceInstaller;
    let request = ApplyRequest {
        client: &client,
        update: &config.update,
        current_version: version,
        state_dir: &state_dir,
        installer: &installer,
        restarter: None,
    };
    let outcome = apply_release(&request, &update).await;
    report_outcome(Some(&client), outcome.report()).await;
    match outcome {
        intentra_runner_core::update::apply::ApplyOutcome::Applied { version } => {
            println!(
                "{}",
                serde_json::json!({"applied": version, "restart": "run `intentra-runner start` to load it"})
            );
            EXIT_OK
        }
        outcome => {
            let reason = outcome
                .report()
                .and_then(|report| report.reason.clone())
                .unwrap_or_else(|| "the update failed".to_string());
            eprintln!("update: {}", sanitize_for_log(&reason));
            EXIT_FAILURE
        }
    }
}

async fn command_mcp(job: String, socket: String) -> i32 {
    if !util::validate_job_id(&job) {
        eprintln!("mcp: invalid job id");
        return EXIT_FAILURE;
    }
    let Ok(addr) = socket.parse::<std::net::SocketAddr>() else {
        eprintln!("mcp: --socket must be a loopback address like 127.0.0.1:4555");
        return EXIT_FAILURE;
    };
    let Ok(job_token) = std::env::var("INTENTRA_JOB_TOKEN") else {
        eprintln!("mcp: INTENTRA_JOB_TOKEN is required");
        return EXIT_AUTH;
    };
    let mut client = match mcp::DaemonClient::connect(addr, &job, &job_token).await {
        Ok(client) => client,
        Err(mcp::McpError::Auth) => {
            eprintln!("mcp: the runner daemon rejected the job token");
            return EXIT_AUTH;
        }
        Err(error) => {
            eprintln!("mcp: {error}");
            return EXIT_FAILURE;
        }
    };
    let stdin = tokio::io::BufReader::new(tokio::io::stdin());
    match mcp::serve_stdio(stdin, tokio::io::stdout(), &mut client).await {
        Ok(()) => EXIT_OK,
        Err(error) => {
            eprintln!("mcp: {error}");
            EXIT_FAILURE
        }
    }
}

#[tokio::main]
async fn main() -> std::process::ExitCode {
    let cli = Cli::parse();
    let code = match cli.command {
        Commands::Register {
            server,
            token,
            name,
            config,
        } => command_register(server, token, name, config).await,
        Commands::Start { config } => command_start(config).await,
        Commands::Status { config } => command_status(config),
        Commands::Doctor { config } => command_doctor(config),
        Commands::Mcp { job, socket } => command_mcp(job, socket).await,
        Commands::Update { apply, config } => command_update(apply, config).await,
    };
    std::process::ExitCode::from(code as u8)
}
