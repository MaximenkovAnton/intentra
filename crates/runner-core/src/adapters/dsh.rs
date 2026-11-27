use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use std::process::Stdio;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, BufWriter, Lines};

use tokio::process::{ChildStdin, ChildStdout, Command};
use tokio::sync::watch;

use crate::adapter::{
    AdapterCapabilities, AdapterError, AdapterFuture, AdapterHost, AgentAdapter, AgentEvent,
    AgentResult, DetectResult, JobSpec, NoHost, Permission, Usage,
};
use crate::config::RuntimeConfig;
use crate::protocol::{AdapterInfo, JobResultStatus};
use crate::util::{expand_tilde, now_iso, sha256_hex, tail};

pub const ID: &str = "dsh";
pub const MODEL_KEY_ENV: &str = "INTENTRA_MODEL_API_KEY";
pub const DEFAULT_PROVIDER: &str = "deepseek-official";
pub const DEFAULT_MODEL: &str = "deepseek-flash";
pub const DEFAULT_HOME: &str = "~/.intentra/dsh";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(120);
const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_SUMMARY_BYTES: usize = 4096;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DshConfig {
    pub binary: PathBuf,
    pub dsh_home: PathBuf,
    pub provider: String,
    pub model: String,
    pub env: BTreeMap<String, String>,
    pub request_timeout: Duration,
}

impl DshConfig {
    pub fn from_runtime(runtime: &RuntimeConfig) -> DshConfig {
        DshConfig {
            binary: runtime
                .binary
                .as_deref()
                .map(expand_tilde)
                .unwrap_or_else(|| PathBuf::from("dsh")),
            dsh_home: runtime
                .dsh_home
                .as_deref()
                .map(expand_tilde)
                .unwrap_or_else(|| expand_tilde(DEFAULT_HOME)),
            provider: runtime
                .provider
                .clone()
                .unwrap_or_else(|| DEFAULT_PROVIDER.to_string()),
            model: runtime
                .model
                .clone()
                .unwrap_or_else(|| DEFAULT_MODEL.to_string()),
            env: runtime.env.clone(),
            request_timeout: REQUEST_TIMEOUT,
        }
    }

    fn profile(&self, spec: &JobSpec) -> Profile {
        let seed = format!(
            "{}:{}:{}:{}",
            spec.id,
            spec.cwd.display(),
            self.provider,
            self.model
        );
        let name = format!("intentra-{}", &sha256_hex(seed.as_bytes())[..12]);
        Profile {
            dir: self.dsh_home.join("profiles").join(&name),
            name,
        }
    }
}

struct Profile {
    name: String,
    dir: PathBuf,
}

impl Drop for Profile {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn write_profile(
    config: &DshConfig,
    spec: &JobSpec,
    runner_binary: &Path,
) -> std::io::Result<Profile> {
    let profile = config.profile(spec);
    std::fs::create_dir_all(&profile.dir)?;
    let package = json!({
        "name": format!("dsh-profile-{}", profile.name),
        "private": true,
        "dsh": {"profile": {"bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-sdk-app"]}}
    });
    std::fs::write(
        profile.dir.join("package.json"),
        serde_json::to_vec_pretty(&package)?,
    )?;
    std::fs::write(profile.dir.join("cordis.yml"), "[]\n")?;
    let provider = json!(config.provider).to_string();
    let model = json!(config.model).to_string();
    let command = json!(runner_binary.display().to_string()).to_string();
    let args = json!(["mcp", "--job", spec.id, "--socket", spec.tools.socket]).to_string();
    let patch = [
        "- id: llm-deepseek".to_string(),
        "  config:".to_string(),
        format!("    apiKeyEnv: {MODEL_KEY_ENV}"),
        "- id: agent-default-model".to_string(),
        "  config:".to_string(),
        format!("    provider: {provider}"),
        format!("    model: {model}"),
        "- insert:".to_string(),
        "    - id: intentra-mcp".to_string(),
        "      name: '@deepseek-ai/dsh-mcp-client'".to_string(),
        "      config:".to_string(),
        "        serverName: intentra".to_string(),
        "        transport: stdio".to_string(),
        format!("        command: {command}"),
        format!("        args: {args}"),
        "        env:".to_string(),
        "          INTENTRA_JOB_TOKEN: !!js process.env.INTENTRA_JOB_TOKEN".to_string(),
    ]
    .join("\n");
    std::fs::write(profile.dir.join("cordis.patch.yml"), format!("{patch}\n"))?;
    Ok(profile)
}

fn session_id(spec: &JobSpec) -> String {
    format!("intentra-{}-{}", spec.id, &crate::util::random_token()[..8])
}

// shortcut: the approval payload names only the tool, so the policy is tool-name level; upgrade when dsh-sdk-protocol carries the operation target.
fn approval_outcome(permission: Permission, tool: &str) -> &'static str {
    if permission == Permission::DangerFullAccess {
        return "allowed-once";
    }
    if matches!(
        tool,
        "read" | "write" | "edit" | "glob" | "grep" | "str_replace_editor" | "present"
    ) {
        return "allowed-once";
    }
    "rejected"
}

#[derive(Default)]
struct RunState {
    summary: String,
    usage: Usage,
    calls: HashMap<String, String>,
    completed: Vec<String>,
    failure: Option<String>,
}

struct Rpc {
    stdin: BufWriter<ChildStdin>,
    lines: Lines<BufReader<ChildStdout>>,
    next_id: u64,
    session_id: String,
    stage: String,
    permission: Permission,
}

impl Rpc {
    fn new(
        stdin: ChildStdin,
        stdout: ChildStdout,
        session_id: String,
        stage: String,
        permission: Permission,
    ) -> Rpc {
        Rpc {
            stdin: BufWriter::new(stdin),
            lines: BufReader::new(stdout).lines(),
            next_id: 1,
            session_id,
            stage,
            permission,
        }
    }

    async fn send(&mut self, method: &str, params: Option<Value>) -> Result<u64, AdapterError> {
        let id = self.next_id;
        self.next_id += 1;
        let frame = match params {
            Some(params) => json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params}),
            None => json!({"jsonrpc": "2.0", "id": id, "method": method}),
        };
        self.stdin
            .write_all(format!("{frame}\n").as_bytes())
            .await
            .map_err(|error| AdapterError::new(ID, format!("cannot write to dsh: {error}")))?;
        self.stdin
            .flush()
            .await
            .map_err(|error| AdapterError::new(ID, format!("cannot write to dsh: {error}")))?;
        Ok(id)
    }

    async fn send_response(&mut self, id: Value, result: Value) -> Result<(), AdapterError> {
        let frame = json!({"jsonrpc": "2.0", "id": id, "result": result});
        self.stdin
            .write_all(format!("{frame}\n").as_bytes())
            .await
            .map_err(|error| AdapterError::new(ID, format!("cannot answer dsh: {error}")))?;
        self.stdin
            .flush()
            .await
            .map_err(|error| AdapterError::new(ID, format!("cannot answer dsh: {error}")))
    }

    async fn next_frame(&mut self, deadline: Instant) -> Result<Value, AdapterError> {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(AdapterError::new(ID, "dsh did not answer in time"));
        }
        let line = tokio::time::timeout(remaining, self.lines.next_line())
            .await
            .map_err(|_| AdapterError::new(ID, "dsh did not answer in time"))?
            .map_err(|error| AdapterError::new(ID, format!("cannot read from dsh: {error}")))?
            .ok_or_else(|| AdapterError::new(ID, "dsh closed its stdout"))?;
        serde_json::from_str(line.trim())
            .map_err(|error| AdapterError::new(ID, format!("invalid JSON-RPC frame: {error}")))
    }

    async fn request(
        &mut self,
        method: &str,
        params: Value,
        state: &mut RunState,
        host: &dyn AdapterHost,
        job_id: &str,
        timeout: Duration,
    ) -> Result<Value, AdapterError> {
        let id = self.send(method, Some(params)).await?;
        let mut deadline = Instant::now() + timeout;
        loop {
            let frame = self.next_frame(deadline).await?;
            let handled_at = Instant::now();
            if let Some(result) = self.dispatch(&frame, Some(id), state, host, job_id).await? {
                return Ok(result);
            }
            deadline += handled_at.elapsed();
        }
    }

    async fn dispatch(
        &mut self,
        frame: &Value,
        pending: Option<u64>,
        state: &mut RunState,
        host: &dyn AdapterHost,
        job_id: &str,
    ) -> Result<Option<Value>, AdapterError> {
        let method = frame.get("method").and_then(Value::as_str);
        let id = frame.get("id").cloned();
        match method {
            Some(method) => {
                let params = frame.get("params").cloned().unwrap_or(Value::Null);
                match id {
                    Some(id) => {
                        self.answer_server_request(method, id, params, host, job_id)
                            .await?;
                    }
                    None => self.notification(method, &params, state, host, job_id),
                }
                Ok(None)
            }
            None => {
                if pending.is_some() && pending == id.as_ref().and_then(Value::as_u64) {
                    if let Some(error) = frame.get("error")
                        && !error.is_null()
                    {
                        let message = error
                            .get("message")
                            .and_then(Value::as_str)
                            .unwrap_or("dsh returned an error");
                        return Err(AdapterError::new(ID, message));
                    }
                    return Ok(Some(frame.get("result").cloned().unwrap_or(Value::Null)));
                }
                Ok(None)
            }
        }
    }

    async fn answer_server_request(
        &mut self,
        method: &str,
        id: Value,
        params: Value,
        host: &dyn AdapterHost,
        job_id: &str,
    ) -> Result<(), AdapterError> {
        match method {
            "approval/request" => {
                let tool = params
                    .get("toolName")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown");
                let outcome = approval_outcome(self.permission, tool);
                tracing::debug!(tool, outcome, "dsh approval decision");
                self.send_response(id, json!({ "outcome": outcome })).await
            }
            "user-question/ask" => {
                let mut question = params;
                if let Some(object) = question.as_object_mut() {
                    object.insert("stage".to_string(), json!(self.stage));
                }
                host.event(
                    job_id,
                    AgentEvent::Question {
                        question: question.clone(),
                    },
                );
                let answer = host
                    .ask(job_id, question)
                    .await
                    .unwrap_or_else(|| json!({"cancelled": true}));
                self.send_response(id, answer).await
            }
            other => {
                let frame = json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "error": {"code": -32601, "message": format!("unsupported request {other}")}
                });
                self.stdin
                    .write_all(format!("{frame}\n").as_bytes())
                    .await
                    .map_err(|error| {
                        AdapterError::new(ID, format!("cannot answer dsh: {error}"))
                    })?;
                self.stdin
                    .flush()
                    .await
                    .map_err(|error| AdapterError::new(ID, format!("cannot answer dsh: {error}")))
            }
        }
    }

    fn notification(
        &mut self,
        method: &str,
        params: &Value,
        state: &mut RunState,
        host: &dyn AdapterHost,
        job_id: &str,
    ) {
        match method {
            "session.event" => {
                for event in map_session_event(params, state) {
                    host.event(job_id, event);
                }
            }
            "session.status" => {
                if let Some(status) = params.get("status").and_then(Value::as_str)
                    && matches!(status, "running" | "idle")
                {
                    host.event(
                        job_id,
                        AgentEvent::Status {
                            state: status.to_string(),
                            at: now_iso(),
                        },
                    );
                }
            }
            "session.query.completed" => {
                if let Some(command_id) = params.get("commandId").and_then(Value::as_str) {
                    state.completed.push(command_id.to_string());
                }
            }
            "user-question.cancelled" => {
                tracing::debug!(job = job_id, "dsh cancelled a pending question");
            }
            _ => {}
        }
    }

    async fn wait_command(
        &mut self,
        command_id: &str,
        state: &mut RunState,
        host: &dyn AdapterHost,
        job_id: &str,
    ) -> Result<(), AdapterError> {
        let deadline = Instant::now() + REQUEST_TIMEOUT;
        while !state.completed.iter().any(|id| id == command_id) {
            let frame = self.next_frame(deadline).await?;
            self.dispatch(&frame, None, state, host, job_id).await?;
        }
        Ok(())
    }

    async fn session(
        &mut self,
        spec: &JobSpec,
        config: &DshConfig,
        host: &dyn AdapterHost,
    ) -> Result<AgentResult, AdapterError> {
        let mut state = RunState::default();
        let model = spec.model.clone().unwrap_or_else(|| config.model.clone());
        let initialize = json!({
            "cwd": spec.cwd.display().to_string(),
            "approvalRequests": true,
            "provider": config.provider,
            "model": model,
            "capabilities": {"userQuestions": true}
        });
        let initialized = self
            .request(
                "initialize",
                initialize,
                &mut state,
                host,
                &spec.id,
                config.request_timeout,
            )
            .await?;
        if initialized.get("serverInfo").is_none() {
            return Err(AdapterError::new(ID, "invalid initialize result"));
        }
        self.request(
            "session/working-directory/set",
            json!({"sessionId": self.session_id, "path": spec.cwd.display().to_string()}),
            &mut state,
            host,
            &spec.id,
            config.request_timeout,
        )
        .await?;
        let permission = self
            .request(
                "session/query",
                json!({
                    "sessionId": self.session_id,
                    "contentBlocks": [{"type": "text", "text": "/permission workspace-write"}]
                }),
                &mut state,
                host,
                &spec.id,
                config.request_timeout,
            )
            .await?;
        if let Some(command_id) = permission
            .get("execution")
            .and_then(|execution| execution.get("commandId"))
            .and_then(Value::as_str)
            .map(str::to_string)
        {
            self.wait_command(&command_id, &mut state, host, &spec.id)
                .await?;
        }
        self.request(
            "session/query",
            json!({
                "sessionId": self.session_id,
                "contentBlocks": [{"type": "text", "text": spec.prompt}]
            }),
            &mut state,
            host,
            &spec.id,
            config.request_timeout,
        )
        .await?;
        self.request(
            "session/wait",
            json!({"sessionId": self.session_id}),
            &mut state,
            host,
            &spec.id,
            Duration::from_secs(spec.limits.timeout_seconds),
        )
        .await?;
        if let Some(failure) = state.failure {
            return Err(AdapterError::new(ID, failure));
        }
        let summary = if state.summary.trim().is_empty() {
            "dsh session completed".to_string()
        } else {
            tail(state.summary.trim(), MAX_SUMMARY_BYTES)
        };
        Ok(AgentResult {
            status: JobResultStatus::Succeeded,
            summary: Some(summary),
            findings: None,
            verdict: None,
            usage: state.usage,
            links: Vec::new(),
        })
    }

    async fn shutdown(&mut self) -> Result<(), AdapterError> {
        let id = self.send("shutdown", None).await?;
        let deadline = Instant::now() + SHUTDOWN_TIMEOUT;
        loop {
            let frame = self.next_frame(deadline).await?;
            let mut state = RunState::default();
            if self
                .dispatch(&frame, Some(id), &mut state, &NoHost, "")
                .await?
                .is_some()
            {
                return Ok(());
            }
        }
    }
}

fn map_session_event(params: &Value, state: &mut RunState) -> Vec<AgentEvent> {
    let Some(event) = params.get("event") else {
        return Vec::new();
    };
    let kind = event
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let data = event.get("data").unwrap_or(&Value::Null);
    let at = now_iso();
    match kind {
        "tool/call" => {
            let name = data
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("tool")
                .to_string();
            if let Some(call_id) = data.get("callId").and_then(Value::as_str) {
                state.calls.insert(call_id.to_string(), name.clone());
            }
            vec![AgentEvent::Tool {
                name,
                status: "started".to_string(),
                at,
            }]
        }
        "tool/result" => {
            let call_id = data
                .get("message")
                .and_then(|message| message.get("toolCallId"))
                .and_then(Value::as_str)
                .unwrap_or_default();
            let name = state
                .calls
                .remove(call_id)
                .unwrap_or_else(|| "tool".to_string());
            vec![AgentEvent::Tool {
                name,
                status: "finished".to_string(),
                at,
            }]
        }
        "turn/end" => {
            let reason = data.get("reason").unwrap_or(&Value::Null);
            if reason.get("kind").and_then(Value::as_str) == Some("error") {
                let message = reason
                    .get("error")
                    .and_then(|error| error.get("message"))
                    .and_then(Value::as_str)
                    .unwrap_or("dsh ended the turn with an error");
                state.failure = Some(message.to_string());
            }
            Vec::new()
        }
        "assistant/message" => {
            if let Some(text) = assistant_text(data)
                && !text.trim().is_empty()
            {
                if !state.summary.is_empty() {
                    state.summary.push('\n');
                }
                state.summary.push_str(text.trim());
            }
            let usage = data.get("usage");
            let input = usage
                .and_then(|usage| usage.get("inputTokens"))
                .and_then(Value::as_u64);
            let output = usage
                .and_then(|usage| usage.get("outputTokens"))
                .and_then(Value::as_u64);
            if input.is_none() && output.is_none() {
                return Vec::new();
            }
            state.usage.input_tokens = add(state.usage.input_tokens, input);
            state.usage.output_tokens = add(state.usage.output_tokens, output);
            vec![AgentEvent::Usage {
                input_tokens: input,
                output_tokens: output,
                at,
            }]
        }
        _ => Vec::new(),
    }
}

fn add(total: Option<u64>, value: Option<u64>) -> Option<u64> {
    match (total, value) {
        (Some(total), Some(value)) => Some(total + value),
        (total, value) => total.or(value),
    }
}

fn assistant_text(data: &Value) -> Option<String> {
    let content = data.get("message")?.get("content")?.as_array()?;
    let mut text = String::new();
    for block in content {
        if block.get("type").and_then(Value::as_str) == Some("text")
            && let Some(part) = block.get("text").and_then(Value::as_str)
        {
            text.push_str(part);
        }
    }
    Some(text)
}

fn child_env<'a>(
    config: &'a DshConfig,
    spec: &'a JobSpec,
) -> impl Iterator<Item = (String, String)> + 'a {
    let mut env = config.env.clone();
    env.extend(spec.env.clone());
    if !env.contains_key(MODEL_KEY_ENV)
        && let Ok(key) = std::env::var(MODEL_KEY_ENV)
    {
        env.insert(MODEL_KEY_ENV.to_string(), key);
    }
    env.into_iter()
}

type Running = Mutex<HashMap<String, watch::Sender<bool>>>;

struct RunningGuard<'a> {
    running: &'a Running,
    job_id: String,
}

impl Drop for RunningGuard<'_> {
    fn drop(&mut self) {
        if let Ok(mut running) = self.running.lock() {
            running.remove(&self.job_id);
        }
    }
}

pub struct DshAdapter {
    config: DshConfig,
    host: Arc<dyn AdapterHost>,
    running: Running,
}

impl DshAdapter {
    pub fn new(config: DshConfig, host: Arc<dyn AdapterHost>) -> DshAdapter {
        DshAdapter {
            config,
            host,
            running: Mutex::new(HashMap::new()),
        }
    }

    async fn execute(&self, spec: &JobSpec) -> Result<AgentResult, AdapterError> {
        let runner_binary =
            std::env::current_exe().unwrap_or_else(|_| PathBuf::from("intentra-runner"));
        let profile = write_profile(&self.config, spec, &runner_binary).map_err(|error| {
            AdapterError::new(ID, format!("cannot write the dsh profile: {error}"))
        })?;
        let mut command = Command::new(&self.config.binary);
        command
            .arg("--profile")
            .arg(&profile.name)
            .current_dir(&spec.cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .env_clear();
        for key in ["PATH", "HOME", "SYSTEMROOT", "USERPROFILE"] {
            if let Some(value) = std::env::var_os(key) {
                command.env(key, value);
            }
        }
        command.env("DSH_HOME", &self.config.dsh_home);
        for (key, value) in child_env(&self.config, spec) {
            command.env(key, value);
        }
        command.env("INTENTRA_JOB_TOKEN", &spec.tools.token);
        let mut child = command.spawn().map_err(|error| {
            AdapterError::new(
                ID,
                format!("cannot start {}: {error}", self.config.binary.display()),
            )
        })?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| AdapterError::new(ID, "dsh has no stdin"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| AdapterError::new(ID, "dsh has no stdout"))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| AdapterError::new(ID, "dsh has no stderr"))?;
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while matches!(lines.next_line().await, Ok(Some(_))) {}
        });
        let (cancel, mut cancelled) = watch::channel(false);
        self.running
            .lock()
            .expect("adapter lock")
            .insert(spec.id.clone(), cancel);
        let _guard = RunningGuard {
            running: &self.running,
            job_id: spec.id.clone(),
        };
        let mut rpc = Rpc::new(
            stdin,
            stdout,
            session_id(spec),
            spec.stage.clone(),
            spec.permission,
        );
        let outcome = {
            let session = rpc.session(spec, &self.config, self.host.as_ref());
            tokio::pin!(session);
            tokio::select! {
                result = &mut session => result,
                _ = cancelled.changed() => Err(AdapterError::new(ID, "cancelled")),
            }
        };
        if outcome.is_ok() {
            let _ = tokio::time::timeout(SHUTDOWN_TIMEOUT, rpc.shutdown()).await;
        }
        let _ = child.start_kill();
        let _ = tokio::time::timeout(SHUTDOWN_TIMEOUT, child.wait()).await;
        outcome
    }
}

impl AgentAdapter for DshAdapter {
    fn info(&self) -> AdapterInfo {
        AdapterInfo {
            id: ID.to_string(),
            label: "DSH".to_string(),
        }
    }

    fn capabilities(&self) -> AdapterCapabilities {
        AdapterCapabilities {
            sessions: true,
            streaming: true,
            mcp_tools: true,
            approvals: true,
            user_questions: true,
            model_selection: true,
            resume: false,
        }
    }

    fn detect<'a>(&'a self) -> AdapterFuture<'a, DetectResult> {
        Box::pin(async move {
            let output = tokio::time::timeout(
                Duration::from_secs(10),
                Command::new(&self.config.binary).arg("--version").output(),
            )
            .await;
            match output {
                Ok(Ok(output)) if output.status.success() => {
                    let version = String::from_utf8_lossy(&output.stdout)
                        .lines()
                        .next()
                        .unwrap_or_default()
                        .trim()
                        .to_string();
                    if version.is_empty() {
                        DetectResult::available(self.config.binary.display().to_string())
                    } else {
                        DetectResult::available(version)
                    }
                }
                Ok(Ok(output)) => DetectResult::unavailable(format!(
                    "{} --version exited with {}",
                    self.config.binary.display(),
                    output.status
                )),
                Ok(Err(error)) => DetectResult::unavailable(format!(
                    "cannot run {}: {error}",
                    self.config.binary.display()
                )),
                Err(_) => DetectResult::unavailable(format!(
                    "{} --version timed out",
                    self.config.binary.display()
                )),
            }
        })
    }

    fn run<'a>(&'a self, spec: JobSpec) -> AdapterFuture<'a, Result<AgentResult, AdapterError>> {
        Box::pin(async move { self.execute(&spec).await })
    }

    fn cancel<'a>(&'a self, job_id: &'a str) -> AdapterFuture<'a, ()> {
        Box::pin(async move {
            if let Some(cancel) = self.running.lock().expect("adapter lock").get(job_id) {
                let _ = cancel.send(true);
            }
        })
    }
}

#[cfg(all(test, unix))]
fn executable_script(path: &Path, body: &str) {
    std::fs::write(path, body).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::adapter::{JobLimits, McpEndpoint};

    #[cfg(unix)]
    struct TestHost {
        events: Mutex<Vec<AgentEvent>>,
        answer: Value,
        delay: Duration,
        asked: Mutex<Vec<Value>>,
    }

    #[cfg(unix)]
    impl TestHost {
        fn new(answer: Value) -> Arc<TestHost> {
            TestHost::delayed(answer, Duration::ZERO)
        }

        fn delayed(answer: Value, delay: Duration) -> Arc<TestHost> {
            Arc::new(TestHost {
                events: Mutex::new(Vec::new()),
                answer,
                delay,
                asked: Mutex::new(Vec::new()),
            })
        }
    }

    #[cfg(unix)]
    impl AdapterHost for TestHost {
        fn event(&self, _job_id: &str, event: AgentEvent) {
            self.events.lock().unwrap().push(event);
        }

        fn ask<'a>(
            &'a self,
            _job_id: &'a str,
            question: Value,
        ) -> AdapterFuture<'a, Option<Value>> {
            Box::pin(async move {
                self.asked.lock().unwrap().push(question);
                tokio::time::sleep(self.delay).await;
                Some(self.answer.clone())
            })
        }
    }

    fn spec(cwd: PathBuf) -> JobSpec {
        JobSpec {
            id: "job-1".to_string(),
            intent_id: "intent-1".to_string(),
            stage: "build".to_string(),
            prompt: "add the thing".to_string(),
            context: Value::Null,
            cwd,
            limits: JobLimits {
                timeout_seconds: 60,
            },
            tools: McpEndpoint {
                socket: "127.0.0.1:4555".to_string(),
                token: "job-token-value".to_string(),
            },
            model: None,
            permission: Permission::WorkspaceWrite,
            env: BTreeMap::new(),
        }
    }

    fn config(home: &Path, binary: PathBuf) -> DshConfig {
        DshConfig {
            binary,
            dsh_home: home.join("dsh"),
            provider: "deepseek-official".to_string(),
            model: "deepseek-flash".to_string(),
            env: BTreeMap::new(),
            request_timeout: REQUEST_TIMEOUT,
        }
    }

    #[test]
    fn the_profile_carries_the_mcp_stdio_row_and_never_a_secret() {
        let home = tempfile::tempdir().unwrap();
        let work = tempfile::tempdir().unwrap();
        let config = config(home.path(), PathBuf::from("dsh"));
        let spec = spec(work.path().to_path_buf());
        let profile =
            write_profile(&config, &spec, Path::new("/usr/local/bin/intentra-runner")).unwrap();
        let patch = std::fs::read_to_string(profile.dir.join("cordis.patch.yml")).unwrap();
        assert!(patch.contains("@deepseek-ai/dsh-mcp-client"), "{patch}");
        assert!(patch.contains("transport: stdio"), "{patch}");
        assert!(patch.contains("serverName: intentra"), "{patch}");
        assert!(
            patch.contains("apiKeyEnv: INTENTRA_MODEL_API_KEY"),
            "{patch}"
        );
        assert!(patch.contains("provider: \"deepseek-official\""), "{patch}");
        assert!(patch.contains("model: \"deepseek-flash\""), "{patch}");
        assert!(patch.contains(r#""mcp","--job","job-1""#), "{patch}");
        assert!(!patch.contains("job-token-value"), "{patch}");
        let package = std::fs::read_to_string(profile.dir.join("package.json")).unwrap();
        assert!(package.contains("@deepseek-ai/dsh-sdk-app"), "{package}");
        assert_eq!(
            std::fs::read_to_string(profile.dir.join("cordis.yml")).unwrap(),
            "[]\n"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn detect_reports_the_binary_version_and_refuses_an_absent_dsh() {
        let home = tempfile::tempdir().unwrap();
        let script = home.path().join("fake-dsh");
        executable_script(
            &script,
            "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo 'dsh 9.9.9'; exit 0; fi\nexit 0\n",
        );
        let found = DshAdapter::new(config(home.path(), script), Arc::new(NoHost))
            .detect()
            .await;
        assert!(found.available);
        assert_eq!(found.version.as_deref(), Some("dsh 9.9.9"));
        let missing = DshAdapter::new(
            config(home.path(), home.path().join("missing-dsh")),
            Arc::new(NoHost),
        )
        .detect()
        .await;
        assert!(!missing.available, "{missing:?}");
        assert!(missing.reason.is_some());
    }

    #[tokio::test]
    async fn a_real_dsh_is_only_smoked_when_it_is_installed() {
        let adapter = DshAdapter::new(
            DshConfig {
                binary: PathBuf::from("dsh"),
                dsh_home: tempfile::tempdir().unwrap().path().join("dsh"),
                provider: DEFAULT_PROVIDER.to_string(),
                model: DEFAULT_MODEL.to_string(),
                env: BTreeMap::new(),
                request_timeout: REQUEST_TIMEOUT,
            },
            Arc::new(NoHost),
        );
        let detected = adapter.detect().await;
        if !detected.available {
            return;
        }
        assert!(detected.version.is_some());
    }

    #[cfg(unix)]
    fn fake_runtime(home: &Path) -> PathBuf {
        let script = home.join("fake-dsh");
        executable_script(
            &script,
            r#"#!/bin/sh
if [ "$1" = "--version" ]; then echo 'dsh 9.9.9'; exit 0; fi
profile=""
while [ $# -gt 0 ]; do
  case "$1" in
    --profile) shift; profile="$1";;
  esac
  shift
done
patch="$DSH_HOME/profiles/$profile/cordis.patch.yml"
grep -q 'dsh-mcp-client' "$patch" || { echo "mcp row missing" >&2; exit 41; }
grep -q 'transport: stdio' "$patch" || { echo "stdio missing" >&2; exit 42; }
[ -f "$DSH_HOME/profiles/$profile/package.json" ] || { echo "package missing" >&2; exit 43; }
read -r line
sleep "${FAKE_HANDSHAKE_DELAY_SECONDS:-0}"
case "$line" in *'"approvalRequests":true'*) ;; *) echo "approvals missing" >&2; exit 44;; esac
printf '{"jsonrpc":"2.0","id":1,"result":{"serverInfo":{"name":"deepseek-harness-sdk-runtime","version":"9.9.9"}}}\n'
read -r line
printf '{"jsonrpc":"2.0","id":2,"result":{"cwd":"%s"}}\n' "$INTENTRA_WORKDIR"
read -r line
case "$line" in *'/permission workspace-write'*) ;; *) echo "permission command missing: $line" >&2; exit 47;; esac
printf '{"jsonrpc":"2.0","method":"session.query.completed","params":{"sessionId":"s","commandId":"c1","finalResponse":"","finishReason":"stop"}}\n'
printf '{"jsonrpc":"2.0","id":3,"result":{"kind":"command","execution":{"commandId":"c1"}}}\n'
read -r line
printf '{"jsonrpc":"2.0","method":"session.status","params":{"sessionId":"s","status":"running"}}\n'
printf '{"jsonrpc":"2.0","method":"session.event","params":{"sessionId":"s","event":{"type":"tool/call","seq":1,"time":0,"data":{"turn":1,"step":1,"callId":"call-1","name":"read","arguments":"{}"}}}}\n'
printf '{"jsonrpc":"2.0","id":900,"method":"approval/request","params":{"sessionId":"s","toolName":"read"}}\n'
read -r answer
case "$answer" in *'"outcome":"allowed-once"'*) ;; *) echo "bad approval: $answer" >&2; exit 45;; esac
printf '{"jsonrpc":"2.0","id":901,"method":"user-question/ask","params":{"requestId":"rq-1","sessionId":"s","questions":[{"id":"q1","question":"Which?"}]}}\n'
read -r answer
case "$answer" in *'"answers"'*) ;; *) echo "bad answer: $answer" >&2; exit 46;; esac
printf '{"jsonrpc":"2.0","id":4,"result":{"kind":"prompt","messageId":"m1"}}\n'
printf '{"jsonrpc":"2.0","method":"session.event","params":{"sessionId":"s","event":{"type":"tool/result","seq":2,"time":0,"data":{"turn":1,"step":1,"message":{"role":"tool","toolCallId":"call-1","content":[]}}}}}\n'
printf '{"jsonrpc":"2.0","method":"session.event","params":{"sessionId":"s","event":{"type":"assistant/message","seq":3,"time":0,"data":{"turn":1,"step":1,"message":{"role":"assistant","content":[{"type":"text","text":"fake dsh finished"}]},"usage":{"inputTokens":7,"outputTokens":3}}}}}\n'
if [ "${FAKE_TURN_ERROR:-}" = "1" ]; then
  printf '{"jsonrpc":"2.0","method":"session.event","params":{"sessionId":"s","event":{"type":"turn/end","seq":4,"time":0,"data":{"turn":1,"reason":{"kind":"error","error":{"message":"llm-deepseek: no API key for provider route","code":"MISSING_CREDENTIAL"}}}}}}\n'
fi
printf '{"jsonrpc":"2.0","method":"session.status","params":{"sessionId":"s","status":"idle"}}\n'
read -r line
sleep "${FAKE_WAIT_SECONDS:-0}"
printf '{"jsonrpc":"2.0","id":5,"result":{}}\n'
read -r line
printf '{"jsonrpc":"2.0","id":6,"result":{}}\n'
exit 0
"#,
        );
        script
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn the_session_handshake_questions_and_approvals_work_against_a_fake_dsh() {
        let home = tempfile::tempdir().unwrap();
        let work = tempfile::tempdir().unwrap();
        let script = fake_runtime(home.path());
        let host = TestHost::new(json!({"answers": [{"id": "q1", "selected": ["a"]}]}));
        let adapter = Arc::new(DshAdapter::new(
            config(home.path(), script),
            Arc::clone(&host) as Arc<dyn AdapterHost>,
        ));
        // The fake runtime reports this working directory back to the client.
        let mut env_spec = spec(work.path().to_path_buf());
        env_spec.env.insert(
            "INTENTRA_WORKDIR".to_string(),
            work.path().display().to_string(),
        );
        let result = adapter.run(env_spec).await.unwrap();
        assert_eq!(result.status, JobResultStatus::Succeeded);
        assert_eq!(result.summary.as_deref(), Some("fake dsh finished"));
        assert_eq!(result.usage.input_tokens, Some(7));
        assert_eq!(result.usage.output_tokens, Some(3));
        let asked = host.asked.lock().unwrap();
        assert_eq!(asked.len(), 1);
        assert_eq!(asked[0]["questions"][0]["id"], "q1");
        let events = host.events.lock().unwrap();
        let shape: Vec<String> = events
            .iter()
            .map(|event| match event {
                AgentEvent::Status { state, .. } => format!("status:{state}"),
                AgentEvent::Tool { name, status, .. } => format!("tool:{name}:{status}"),
                AgentEvent::Usage { .. } => "usage".to_string(),
                AgentEvent::Question { .. } => "question".to_string(),
                AgentEvent::Log { .. } => "log".to_string(),
            })
            .collect();
        assert_eq!(
            shape,
            vec![
                "status:running",
                "tool:read:started",
                "question",
                "tool:read:finished",
                "usage",
                "status:idle",
            ]
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn the_handshake_is_bounded_by_its_request_timeout() {
        let home = tempfile::tempdir().unwrap();
        let work = tempfile::tempdir().unwrap();
        let mut config = config(home.path(), fake_runtime(home.path()));
        config.request_timeout = Duration::from_secs(2);
        let adapter = DshAdapter::new(config, Arc::new(NoHost));
        let mut spec = spec(work.path().to_path_buf());
        spec.env
            .insert("FAKE_HANDSHAKE_DELAY_SECONDS".to_string(), "3".to_string());
        let error = adapter.run(spec).await.unwrap_err();
        assert!(error.to_string().contains("in time"), "{error}");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_slow_turn_is_not_cut_off_by_the_handshake_timeout() {
        let home = tempfile::tempdir().unwrap();
        let work = tempfile::tempdir().unwrap();
        let mut config = config(home.path(), fake_runtime(home.path()));
        config.request_timeout = Duration::from_secs(2);
        let host = TestHost::new(json!({"answers": [{"id": "q1", "selected": ["a"]}]}));
        let adapter = DshAdapter::new(config, Arc::clone(&host) as Arc<dyn AdapterHost>);
        let mut spec = spec(work.path().to_path_buf());
        spec.env
            .insert("FAKE_WAIT_SECONDS".to_string(), "3".to_string());
        let result = adapter.run(spec).await.unwrap();
        assert_eq!(result.status, JobResultStatus::Succeeded);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_human_answer_is_not_cut_off_by_the_handshake_timeout() {
        let home = tempfile::tempdir().unwrap();
        let work = tempfile::tempdir().unwrap();
        let mut config = config(home.path(), fake_runtime(home.path()));
        config.request_timeout = Duration::from_secs(2);
        let host = TestHost::delayed(
            json!({"answers": [{"id": "q1", "selected": ["a"]}]}),
            Duration::from_secs(3),
        );
        let adapter = DshAdapter::new(config, Arc::clone(&host) as Arc<dyn AdapterHost>);
        let result = adapter.run(spec(work.path().to_path_buf())).await.unwrap();
        assert_eq!(result.status, JobResultStatus::Succeeded);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_failed_turn_fails_the_job_instead_of_claiming_success() {
        let home = tempfile::tempdir().unwrap();
        let work = tempfile::tempdir().unwrap();
        let adapter = DshAdapter::new(
            config(home.path(), fake_runtime(home.path())),
            TestHost::new(json!({"answers": [{"id": "q1", "selected": ["a"]}]})),
        );
        let mut spec = spec(work.path().to_path_buf());
        spec.env
            .insert("FAKE_TURN_ERROR".to_string(), "1".to_string());
        let error = adapter.run(spec).await.unwrap_err();
        assert!(error.to_string().contains("no API key"), "{error}");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn child_stderr_never_enters_the_error() {
        let home = tempfile::tempdir().unwrap();
        let script = home.path().join("leaky-dsh");
        executable_script(
            &script,
            r#"#!/bin/sh
if [ "$1" = "--version" ]; then echo 'dsh 9.9.9'; exit 0; fi
read -r line
echo "diagnostic: $INTENTRA_JOB_TOKEN" >&2
exit 1
"#,
        );
        let adapter = DshAdapter::new(config(home.path(), script), Arc::new(NoHost));
        let work = tempfile::tempdir().unwrap();
        let error = adapter
            .run(spec(work.path().to_path_buf()))
            .await
            .unwrap_err();
        let text = error.to_string();
        assert!(!text.contains("job-token-value"), "{text}");
        assert!(!text.contains("diagnostic"), "{text}");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn cancel_stops_the_child_process() {
        let home = tempfile::tempdir().unwrap();
        let script = home.path().join("hanging-dsh");
        executable_script(
            &script,
            r#"#!/bin/sh
if [ "$1" = "--version" ]; then echo 'dsh 9.9.9'; exit 0; fi
read -r line
printf '{"jsonrpc":"2.0","id":1,"result":{"serverInfo":{"name":"deepseek-harness-sdk-runtime","version":"9.9.9"}}}\n'
read -r line
sleep 30
"#,
        );
        let adapter = Arc::new(DshAdapter::new(
            config(home.path(), script),
            Arc::new(NoHost),
        ));
        let work = tempfile::tempdir().unwrap();
        let running = {
            let adapter = Arc::clone(&adapter);
            tokio::spawn(async move { adapter.run(spec(work.path().to_path_buf())).await })
        };
        tokio::time::sleep(Duration::from_millis(300)).await;
        adapter.cancel("job-1").await;
        let result = tokio::time::timeout(Duration::from_secs(10), running)
            .await
            .expect("run must finish after cancel")
            .unwrap();
        let error = result.unwrap_err();
        assert!(error.to_string().contains("cancelled"), "{error}");
    }
}
