use std::collections::BTreeMap;
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::Value;
use std::process::Stdio;
use tokio::io::AsyncWriteExt;

use tokio::process::Command;
use tokio::sync::watch;

use crate::adapter::{
    AdapterCapabilities, AdapterError, AdapterFuture, AdapterHost, AgentAdapter, AgentEvent,
    AgentResult, DetectResult, JobSpec, Usage,
};
use crate::config::{OutputMode, PromptMode, RuntimeConfig};
use crate::protocol::{AdapterInfo, JobResultStatus};
use crate::util::{expand_tilde, now_iso, tail};

pub const ID: &str = "cli";
const MAX_SUMMARY_BYTES: usize = 4096;
const MAX_FIELD_BYTES: usize = 4000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CliConfig {
    pub binary: PathBuf,
    pub args: Vec<String>,
    pub prompt_mode: PromptMode,
    pub output_mode: OutputMode,
    pub timeout_seconds: Option<u64>,
    pub result_file: Option<String>,
    pub env: BTreeMap<String, String>,
}

impl CliConfig {
    pub fn from_runtime(runtime: &RuntimeConfig) -> Result<CliConfig, AdapterError> {
        let binary = runtime
            .binary
            .clone()
            .ok_or_else(|| AdapterError::new(ID, "runtimes.cli.binary is required"))?;
        Ok(CliConfig {
            binary: expand_tilde(&binary),
            args: runtime.args.clone(),
            prompt_mode: runtime.prompt_mode,
            output_mode: runtime.output_mode,
            timeout_seconds: runtime.timeout_sec,
            result_file: runtime.result_file.clone(),
            env: runtime.env.clone(),
        })
    }
}

type Running = Mutex<BTreeMap<String, watch::Sender<bool>>>;

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

pub struct CliAdapter {
    config: CliConfig,
    host: Arc<dyn AdapterHost>,
    running: Running,
}

impl CliAdapter {
    pub fn new(config: CliConfig, host: Arc<dyn AdapterHost>) -> CliAdapter {
        CliAdapter {
            config,
            host,
            running: Mutex::new(BTreeMap::new()),
        }
    }

    async fn execute(&self, spec: &JobSpec) -> Result<AgentResult, AdapterError> {
        let at = now_iso();
        self.host.event(
            &spec.id,
            AgentEvent::Status {
                state: "running".to_string(),
                at,
            },
        );
        let mut command = Command::new(&self.config.binary);
        command
            .args(&self.config.args)
            .current_dir(&spec.cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .envs(&self.config.env)
            .envs(&spec.env);
        if self.config.prompt_mode == PromptMode::Arg {
            command.arg(&spec.prompt);
        }
        let mut child = command.spawn().map_err(|error| {
            AdapterError::new(
                ID,
                format!("cannot start {}: {error}", self.config.binary.display()),
            )
        })?;
        if let Some(mut stdin) = child.stdin.take() {
            if self.config.prompt_mode == PromptMode::Stdin
                && let Err(error) = stdin.write_all(spec.prompt.as_bytes()).await
                && error.kind() != std::io::ErrorKind::BrokenPipe
            {
                return Err(AdapterError::new(
                    ID,
                    format!("cannot write the prompt: {error}"),
                ));
            }
            drop(stdin);
        }
        let timeout = Duration::from_secs(
            self.config
                .timeout_seconds
                .unwrap_or(spec.limits.timeout_seconds)
                .max(1),
        );
        let (cancel, mut cancelled) = watch::channel(false);
        self.running
            .lock()
            .expect("adapter lock")
            .insert(spec.id.clone(), cancel);
        let _guard = RunningGuard {
            running: &self.running,
            job_id: spec.id.clone(),
        };
        let outcome = {
            let wait = child.wait_with_output();
            tokio::pin!(wait);
            tokio::select! {
                output = &mut wait => output.map_err(|error| AdapterError::new(ID, error.to_string())),
                _ = cancelled.changed() => Err(AdapterError::new(ID, "cancelled")),
                _ = tokio::time::sleep(timeout) => Err(AdapterError::new(
                    ID,
                    format!("timed out after {}s", timeout.as_secs()),
                )),
            }
        };
        let output = outcome?;
        let stdout = String::from_utf8_lossy(&output.stdout).to_string();
        let (summary, status, findings, verdict) = if self.config.output_mode == OutputMode::Jsonl {
            let final_json = self.final_json(spec, &stdout)?;
            (
                final_json
                    .summary
                    .or_else(|| Some(format!("cli finished with status {}", output.status))),
                final_json.status,
                final_json.findings,
                final_json.verdict,
            )
        } else {
            (
                Some(tail(stdout.trim(), MAX_SUMMARY_BYTES)),
                None,
                None,
                None,
            )
        };
        if !output.status.success() && status != Some(JobResultStatus::Failed) {
            return Ok(AgentResult {
                status: JobResultStatus::Failed,
                summary: Some(format!(
                    "cli exited with {}; {}",
                    output.status,
                    summary.unwrap_or_default()
                )),
                findings,
                verdict,
                usage: Usage::default(),
                links: Vec::new(),
            });
        }
        let result_status = match status {
            Some(JobResultStatus::Failed) => JobResultStatus::Failed,
            Some(JobResultStatus::Cancelled) => JobResultStatus::Cancelled,
            _ => JobResultStatus::Succeeded,
        };
        self.host.event(
            &spec.id,
            AgentEvent::Status {
                state: "idle".to_string(),
                at: now_iso(),
            },
        );
        Ok(AgentResult {
            status: result_status,
            summary: Some(summary.unwrap_or_default()),
            findings,
            verdict,
            usage: Usage::default(),
            links: Vec::new(),
        })
    }

    fn final_json(&self, spec: &JobSpec, stdout: &str) -> Result<Validated, AdapterError> {
        let raw = match &self.config.result_file {
            Some(relative) => {
                let relative_path = Path::new(relative);
                if relative.is_empty()
                    || relative_path.is_absolute()
                    || relative_path.components().any(|component| {
                        matches!(component, Component::ParentDir | Component::Prefix(_))
                    })
                {
                    return Err(AdapterError::new(
                        ID,
                        "runtimes.cli.result_file must stay inside the worktree",
                    ));
                }
                let path = spec.cwd.join(relative_path);
                std::fs::read_to_string(&path).map_err(|error| {
                    AdapterError::new(
                        ID,
                        format!("cannot read result file {}: {error}", path.display()),
                    )
                })?
            }
            None => stdout
                .lines()
                .rev()
                .find_map(|line| serde_json::from_str::<Value>(line.trim()).ok())
                .map(|value| value.to_string())
                .ok_or_else(|| AdapterError::new(ID, "the CLI printed no final JSON"))?,
        };
        let value: Value = serde_json::from_str(raw.trim())
            .map_err(|error| AdapterError::new(ID, format!("invalid final JSON: {error}")))?;
        parse_final_json(&value).map_err(|error| AdapterError::new(ID, error))
    }
}

impl AgentAdapter for CliAdapter {
    fn info(&self) -> AdapterInfo {
        AdapterInfo {
            id: ID.to_string(),
            label: format!("CLI ({})", self.config.binary.display()),
        }
    }

    fn capabilities(&self) -> AdapterCapabilities {
        AdapterCapabilities {
            sessions: false,
            streaming: self.config.output_mode == OutputMode::Jsonl,
            mcp_tools: false,
            approvals: false,
            user_questions: false,
            model_selection: false,
            resume: false,
        }
    }

    fn detect<'a>(&'a self) -> AdapterFuture<'a, DetectResult> {
        Box::pin(async move {
            match resolve_binary(&self.config.binary) {
                Some(path) => DetectResult::available(path.display().to_string()),
                None => DetectResult::unavailable(format!(
                    "{} is not on PATH",
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

fn resolve_binary(binary: &Path) -> Option<PathBuf> {
    if binary.components().count() > 1 {
        return binary.is_file().then(|| binary.to_path_buf());
    }
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path).find_map(|dir| {
        let candidate = dir.join(binary);
        if candidate.is_file() {
            return Some(candidate);
        }
        let with_suffix = dir.join(format!(
            "{}{}",
            binary.display(),
            std::env::consts::EXE_SUFFIX
        ));
        with_suffix.is_file().then_some(with_suffix)
    })
}

struct Validated {
    summary: Option<String>,
    status: Option<JobResultStatus>,
    findings: Option<Value>,
    verdict: Option<Value>,
}

fn parse_final_json(value: &Value) -> Result<Validated, String> {
    let object = value.as_object().ok_or("final JSON must be an object")?;
    for key in object.keys() {
        if !matches!(key.as_str(), "summary" | "status" | "findings" | "verdict") {
            return Err(format!("unknown final JSON field {key}"));
        }
    }
    let summary = match object.get("summary") {
        None | Some(Value::Null) => None,
        Some(Value::String(text)) => Some(text.clone()),
        Some(_) => return Err("summary must be a string".to_string()),
    };
    let status = match object.get("status") {
        None | Some(Value::Null) => None,
        Some(Value::String(text)) => match text.as_str() {
            "succeeded" => Some(JobResultStatus::Succeeded),
            "failed" => Some(JobResultStatus::Failed),
            "cancelled" => Some(JobResultStatus::Cancelled),
            other => return Err(format!("unknown status {other}")),
        },
        Some(_) => return Err("status must be a string".to_string()),
    };
    let findings = match object.get("findings") {
        None | Some(Value::Null) => None,
        Some(Value::Array(items)) => {
            for item in items {
                validate_finding(item)?;
            }
            Some(Value::Array(items.clone()))
        }
        Some(_) => return Err("findings must be an array".to_string()),
    };
    let verdict = match object.get("verdict") {
        None | Some(Value::Null) => None,
        Some(item) => {
            validate_verdict(item)?;
            Some(item.clone())
        }
    };
    Ok(Validated {
        summary,
        status,
        findings,
        verdict,
    })
}

fn validate_finding(value: &Value) -> Result<(), String> {
    let object = value.as_object().ok_or("a finding must be an object")?;
    for key in object.keys() {
        if !matches!(
            key.as_str(),
            "acId" | "class" | "severity" | "requirement" | "evidence" | "requiredChange"
        ) {
            return Err(format!("unknown finding field {key}"));
        }
    }
    match object.get("class").and_then(Value::as_str) {
        Some(
            "ambiguous" | "missing-evidence" | "contradiction" | "unprovable" | "stale-doc"
            | "scope",
        ) => {}
        _ => return Err("finding.class is not a known class".to_string()),
    }
    match object.get("severity").and_then(Value::as_str) {
        Some("blocking" | "nit") => {}
        _ => return Err("finding.severity must be blocking or nit".to_string()),
    }
    non_empty(object, "requirement", 2000)?;
    for optional in ["acId", "evidence", "requiredChange"] {
        if let Some(Value::String(text)) = object.get(optional) {
            if text.trim().is_empty() {
                return Err(format!("finding.{optional} must not be empty"));
            }
            if optional != "acId" && text.len() > MAX_FIELD_BYTES {
                return Err(format!(
                    "finding.{optional} is longer than {MAX_FIELD_BYTES} bytes"
                ));
            }
        } else if object.get(optional).is_some_and(|value| !value.is_null()) {
            return Err(format!("finding.{optional} must be a string"));
        }
    }
    Ok(())
}

fn validate_verdict(value: &Value) -> Result<(), String> {
    let object = value.as_object().ok_or("verdict must be an object")?;
    for key in object.keys() {
        if !matches!(key.as_str(), "role" | "decision" | "artifactSha256") {
            return Err(format!("unknown verdict field {key}"));
        }
    }
    non_empty(object, "role", 100)?;
    match object.get("decision").and_then(Value::as_str) {
        Some("approve" | "changes" | "block") => {}
        _ => return Err("verdict.decision must be approve, changes or block".to_string()),
    }
    if let Some(sha) = object.get("artifactSha256") {
        let text = sha
            .as_str()
            .ok_or("verdict.artifactSha256 must be a string")?;
        if text.len() != 64 || !text.chars().all(|c| matches!(c, '0'..='9' | 'a'..='f')) {
            return Err("verdict.artifactSha256 must be 64 lowercase hex characters".to_string());
        }
    }
    Ok(())
}

fn non_empty(object: &serde_json::Map<String, Value>, key: &str, max: usize) -> Result<(), String> {
    match object.get(key).and_then(Value::as_str) {
        Some(text) if !text.trim().is_empty() && text.len() <= max => Ok(()),
        _ => Err(format!(
            "{key} must be a non-empty string of at most {max} bytes"
        )),
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::adapter::{JobLimits, McpEndpoint, Permission};
    use serde_json::json;

    fn config(args: &[&str]) -> CliConfig {
        CliConfig {
            binary: PathBuf::from("sh"),
            args: args.iter().map(|arg| arg.to_string()).collect(),
            prompt_mode: PromptMode::Stdin,
            output_mode: OutputMode::Text,
            timeout_seconds: Some(30),
            result_file: None,
            env: BTreeMap::new(),
        }
    }

    fn spec(cwd: PathBuf) -> JobSpec {
        JobSpec {
            id: "job-1".to_string(),
            intent_id: "intent-1".to_string(),
            stage: "build".to_string(),
            prompt: "hello from intentra".to_string(),
            context: Value::Null,
            cwd,
            limits: JobLimits {
                timeout_seconds: 30,
            },
            tools: McpEndpoint {
                socket: "127.0.0.1:1".to_string(),
                token: "job-token".to_string(),
            },
            model: None,
            permission: Permission::WorkspaceWrite,
            env: BTreeMap::new(),
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn the_prompt_reaches_the_cli_on_stdin_and_its_stdout_is_the_summary() {
        let dir = tempfile::tempdir().unwrap();
        let adapter = CliAdapter::new(config(&["-c", "cat"]), Arc::new(crate::adapter::NoHost));
        let result = adapter.run(spec(dir.path().to_path_buf())).await.unwrap();
        assert_eq!(result.status, JobResultStatus::Succeeded);
        assert_eq!(result.summary.as_deref(), Some("hello from intentra"));
        assert!(!adapter.capabilities().mcp_tools);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn arg_mode_appends_the_prompt_as_the_last_argument() {
        let dir = tempfile::tempdir().unwrap();
        let mut config = config(&["-c", "printf %s \"$1\"", "sh"]);
        config.prompt_mode = PromptMode::Arg;
        let adapter = CliAdapter::new(config, Arc::new(crate::adapter::NoHost));
        let result = adapter.run(spec(dir.path().to_path_buf())).await.unwrap();
        assert_eq!(result.summary.as_deref(), Some("hello from intentra"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_slow_cli_is_killed_at_its_timeout() {
        let dir = tempfile::tempdir().unwrap();
        let mut config = config(&["-c", "sleep 30"]);
        config.timeout_seconds = Some(1);
        let adapter = CliAdapter::new(config, Arc::new(crate::adapter::NoHost));
        let error = adapter
            .run(spec(dir.path().to_path_buf()))
            .await
            .unwrap_err();
        assert!(error.to_string().contains("timed out"), "{error}");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn the_final_jsonl_findings_and_verdict_are_validated_and_returned() {
        let dir = tempfile::tempdir().unwrap();
        let payload = json!({
            "summary": "review done",
            "status": "succeeded",
            "findings": [{"class": "scope", "severity": "nit", "requirement": "stay in scope"}],
            "verdict": {"role": "reviewer", "decision": "approve"}
        })
        .to_string();
        let script = format!("printf '%s\\n' '{payload}'");
        let mut config = config(&["-c", &script]);
        config.output_mode = OutputMode::Jsonl;
        let adapter = CliAdapter::new(config, Arc::new(crate::adapter::NoHost));
        let result = adapter.run(spec(dir.path().to_path_buf())).await.unwrap();
        assert_eq!(result.status, JobResultStatus::Succeeded);
        assert_eq!(result.summary.as_deref(), Some("review done"));
        assert_eq!(result.findings.as_ref().unwrap()[0]["class"], "scope");
        assert_eq!(result.verdict.as_ref().unwrap()["decision"], "approve");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn an_unknown_finding_class_fails_the_job() {
        let dir = tempfile::tempdir().unwrap();
        let payload = json!({"summary": "x", "findings": [{"class": "bogus", "severity": "nit", "requirement": "r"}]}).to_string();
        let script = format!("printf '%s\\n' '{payload}'");
        let mut config = config(&["-c", &script]);
        config.output_mode = OutputMode::Jsonl;
        let adapter = CliAdapter::new(config, Arc::new(crate::adapter::NoHost));
        let error = adapter
            .run(spec(dir.path().to_path_buf()))
            .await
            .unwrap_err();
        assert!(error.to_string().contains("class"), "{error}");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn the_result_file_wins_over_stdout_in_jsonl_mode() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("result.json"),
            json!({"summary": "from file", "verdict": {"role": "reviewer", "decision": "block"}})
                .to_string(),
        )
        .unwrap();
        let mut config = config(&["-c", "printf 'noise\\n'"]);
        config.output_mode = OutputMode::Jsonl;
        config.result_file = Some("result.json".to_string());
        let adapter = CliAdapter::new(config, Arc::new(crate::adapter::NoHost));
        let result = adapter.run(spec(dir.path().to_path_buf())).await.unwrap();
        assert_eq!(result.summary.as_deref(), Some("from file"));
        assert_eq!(result.verdict.as_ref().unwrap()["decision"], "block");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_result_file_outside_the_worktree_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let mut config = config(&["-c", "true"]);
        config.output_mode = OutputMode::Jsonl;
        config.result_file = Some("../result.json".to_string());
        let adapter = CliAdapter::new(config, Arc::new(crate::adapter::NoHost));
        let error = adapter
            .run(spec(dir.path().to_path_buf()))
            .await
            .unwrap_err();
        assert!(error.to_string().contains("inside the worktree"), "{error}");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn invalid_final_json_fields_fail_the_job() {
        let cases = [
            (json!({"summary": "x", "status": 3}), "status"),
            (
                json!({
                    "verdict": {
                        "role": "reviewer",
                        "decision": "approve",
                        "artifactSha256": "A".repeat(64)
                    }
                }),
                "artifactSha256",
            ),
        ];
        for (payload, field) in cases {
            let dir = tempfile::tempdir().unwrap();
            let script = format!("printf '%s\\n' '{payload}'");
            let mut config = config(&["-c", &script]);
            config.output_mode = OutputMode::Jsonl;
            let adapter = CliAdapter::new(config, Arc::new(crate::adapter::NoHost));
            let error = adapter
                .run(spec(dir.path().to_path_buf()))
                .await
                .unwrap_err();
            assert!(error.to_string().contains(field), "{field}: {error}");
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn the_stderr_of_the_cli_never_enters_the_result() {
        let dir = tempfile::tempdir().unwrap();
        let mut config = config(&["-c", "echo \"$INTENTRA_JOB_TOKEN\" >&2; exit 3"]);
        config
            .env
            .insert("INTENTRA_JOB_TOKEN".to_string(), "secret-token".to_string());
        let adapter = CliAdapter::new(config, Arc::new(crate::adapter::NoHost));
        let result = adapter.run(spec(dir.path().to_path_buf())).await.unwrap();
        assert_eq!(result.status, JobResultStatus::Failed);
        let text = format!(
            "{:?} {:?} {:?}",
            result.summary, result.findings, result.verdict
        );
        assert!(!text.contains("secret-token"), "{text}");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn the_stderr_of_the_cli_never_enters_the_error() {
        let dir = tempfile::tempdir().unwrap();
        let mut config = config(&["-c", "echo \"$INTENTRA_JOB_TOKEN\" >&2; sleep 30"]);
        config.timeout_seconds = Some(1);
        config
            .env
            .insert("INTENTRA_JOB_TOKEN".to_string(), "secret-token".to_string());
        let adapter = CliAdapter::new(config, Arc::new(crate::adapter::NoHost));
        let error = adapter
            .run(spec(dir.path().to_path_buf()))
            .await
            .unwrap_err();
        assert!(error.to_string().contains("timed out"), "{error}");
        assert!(!error.to_string().contains("secret-token"), "{error}");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn detect_finds_a_binary_on_path_and_refuses_a_missing_one() {
        let present = CliAdapter::new(
            CliConfig {
                binary: PathBuf::from("sh"),
                ..config(&[])
            },
            Arc::new(crate::adapter::NoHost),
        )
        .detect()
        .await;
        assert!(present.available, "{present:?}");
        let missing = CliAdapter::new(
            CliConfig {
                binary: PathBuf::from("intentra-missing-cli"),
                ..config(&[])
            },
            Arc::new(crate::adapter::NoHost),
        )
        .detect()
        .await;
        assert!(!missing.available);
    }
}
