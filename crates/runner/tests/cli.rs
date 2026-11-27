use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Arc;

use intentra_runner_core::daemon::{JobTools, McpServer, Registry};
use intentra_runner_core::state::RunnerState;
use intentra_runner_core::verify;
use serde_json::json;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command as AsyncCommand;

fn binary() -> &'static str {
    env!("CARGO_BIN_EXE_intentra-runner")
}

fn git(dir: &Path, args: &[&str]) {
    let status = Command::new("git")
        .args(args)
        .current_dir(dir)
        .status()
        .expect("git CLI");
    assert!(status.success(), "git {args:?} failed");
}

fn init_repo(dir: &Path) {
    git(dir, &["init", "-q", "-b", "main"]);
    git(dir, &["config", "user.email", "runner@example.test"]);
    git(dir, &["config", "user.name", "Intentra Runner"]);
    std::fs::write(dir.join("README.md"), "hello\n").unwrap();
    git(dir, &["add", "."]);
    git(dir, &["commit", "-q", "-m", "initial"]);
}

fn toml_path(path: &Path) -> String {
    // Windows paths contain backslashes, which are escapes inside a TOML basic
    // string; forward slashes are valid in a Windows path and in TOML.
    path.display().to_string().replace('\\', "/")
}

fn write_config(dir: &Path, token_path: &Path) -> PathBuf {
    let config = format!(
        "server_url = \"wss://intentra.example/api/runner\"\ntoken_path = \"{}\"\nallow_roots = [\"{}\"]\nlog_level = \"info\"\nmax_concurrent_jobs = 1\n\n[workspaces]\np = \"{}\"\n",
        toml_path(token_path),
        toml_path(dir),
        toml_path(dir)
    );
    let path = dir.join("config.toml");
    std::fs::write(&path, config).unwrap();
    path
}

fn write_token(path: &Path) {
    std::fs::write(path, r#"{"runnerId":"runner-1","token":"runner-secret"}"#).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)).unwrap();
    }
}

#[test]
fn version_and_help_describe_every_command() {
    let version = Command::new(binary()).arg("--version").output().unwrap();
    assert!(version.status.success());
    assert!(String::from_utf8_lossy(&version.stdout).contains(env!("CARGO_PKG_VERSION")));
    let help = Command::new(binary()).arg("--help").output().unwrap();
    let text = String::from_utf8_lossy(&help.stdout);
    for command in ["register", "start", "status", "doctor", "mcp"] {
        assert!(text.contains(command), "help must list {command}: {text}");
    }
}

#[test]
fn doctor_passes_on_a_valid_config_and_status_reads_the_state_file() {
    let dir = tempfile::tempdir().unwrap();
    let token = dir.path().join("token");
    write_token(&token);
    let config = write_config(dir.path(), &token);
    let doctor = Command::new(binary())
        .args(["doctor", "--config"])
        .arg(&config)
        .output()
        .unwrap();
    let stdout = String::from_utf8_lossy(&doctor.stdout);
    assert!(doctor.status.success(), "doctor failed: {stdout}");
    assert!(stdout.contains("ok   git"));
    assert!(stdout.contains("ok   token"));

    let missing = Command::new(binary())
        .args(["status", "--config"])
        .arg(&config)
        .output()
        .unwrap();
    assert_eq!(missing.status.code(), Some(5));
    assert!(String::from_utf8_lossy(&missing.stdout).contains("\"running\":false"));

    let state = RunnerState::new("wss://intentra.example/api/runner", "127.0.0.1:4555");
    state.write(dir.path()).unwrap();
    let running = Command::new(binary())
        .args(["status", "--config"])
        .arg(&config)
        .output()
        .unwrap();
    assert_eq!(running.status.code(), Some(0));
    assert!(String::from_utf8_lossy(&running.stdout).contains("\"running\":true"));
}

#[tokio::test]
async fn mcp_over_stdio_answers_list_and_call() {
    let dir = tempfile::tempdir().unwrap();
    init_repo(dir.path());
    std::fs::write(dir.path().join("lib.ts"), "export function find_me() {}\n").unwrap();
    git(dir.path(), &["add", "."]);
    git(dir.path(), &["commit", "-q", "-m", "lib"]);
    let repo_root = dir.path().canonicalize().unwrap();
    let registry = Registry::new();
    let token = registry.register(
        "job-1",
        JobTools {
            job_id: "job-1".to_string(),
            worktree: repo_root.clone(),
            evidence_dir: verify::evidence_dir(&repo_root, "job-1").unwrap(),
            repo_root,
            role: None,
        },
    );
    let server = McpServer::bind(Arc::clone(&registry)).await.unwrap();
    let mut child = AsyncCommand::new(binary())
        .args(["mcp", "--job", "job-1", "--socket", &server.endpoint()])
        .env("INTENTRA_JOB_TOKEN", &token)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    let mut stdout = BufReader::new(child.stdout.take().unwrap());
    let exchanges = [
        (
            json!({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}}),
            "\"protocolVersion\"",
        ),
        (
            json!({"jsonrpc": "2.0", "id": 2, "method": "tools/list"}),
            "repo_search",
        ),
        (
            json!({"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "repo_search", "arguments": {"query": "find"}}}),
            "find_me",
        ),
    ];
    for (request, needle) in exchanges {
        stdin
            .write_all(format!("{request}\n").as_bytes())
            .await
            .unwrap();
        stdin.flush().await.unwrap();
        let mut line = String::new();
        tokio::time::timeout(
            std::time::Duration::from_secs(20),
            stdout.read_line(&mut line),
        )
        .await
        .expect("mcp answers")
        .unwrap();
        assert!(line.contains(needle), "expected {needle} in {line}");
    }
    drop(stdin);
    let _ = child.kill().await;
}
