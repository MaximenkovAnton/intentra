use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;

use crate::git;
use crate::index::Index;
use crate::protocol::{JobFindings, JobSpecMessage, JobVerdict, RunnerMessage};
use crate::util::{random_token, validate_job_id};
use crate::verify::{self, Claim, GateSpec};

#[derive(Debug, Clone)]
pub struct JobTools {
    pub job_id: String,
    pub worktree: PathBuf,
    pub repo_root: PathBuf,
    pub evidence_dir: PathBuf,
    pub role: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct JobReport {
    pub card: Option<Value>,
    pub spec: Option<String>,
    pub plan: Option<Value>,
    pub report: Option<Value>,
    pub findings: Option<Value>,
    pub verdict: Option<Value>,
}

#[derive(Debug)]
struct RegisteredJob {
    token: String,
    tools: JobTools,
}

#[derive(Default)]
pub struct Registry {
    jobs: Mutex<HashMap<String, RegisteredJob>>,
    outbox: Mutex<Option<mpsc::Sender<RunnerMessage>>>,
    next_seq: Mutex<HashMap<String, u64>>,
    reports: Mutex<HashMap<String, JobReport>>,
}

impl Registry {
    pub fn new() -> Arc<Registry> {
        Arc::new(Registry::default())
    }

    pub fn set_outbox(&self, sender: mpsc::Sender<RunnerMessage>) {
        *self.outbox.lock().expect("registry lock") = Some(sender);
    }

    pub fn emit(&self, mut message: RunnerMessage) {
        if let Some(job_id) = message.job_id().map(str::to_string) {
            let mut next = self.next_seq.lock().expect("registry lock");
            let seq = next.entry(job_id).or_insert(1);
            message.set_seq(*seq);
            *seq += 1;
        }
        if let Some(sender) = self.outbox.lock().expect("registry lock").as_ref() {
            let _ = sender.try_send(message);
        }
    }

    pub fn update_report(&self, job_id: &str, update: impl FnOnce(&mut JobReport)) {
        update(
            self.reports
                .lock()
                .expect("registry lock")
                .entry(job_id.to_string())
                .or_default(),
        );
    }

    pub fn take_report(&self, job_id: &str) -> JobReport {
        self.reports
            .lock()
            .expect("registry lock")
            .remove(job_id)
            .unwrap_or_default()
    }

    pub fn register(&self, job_id: &str, tools: JobTools) -> String {
        let token = random_token();
        self.jobs.lock().expect("registry lock").insert(
            job_id.to_string(),
            RegisteredJob {
                token: token.clone(),
                tools,
            },
        );
        token
    }

    pub fn unregister(&self, job_id: &str) {
        self.jobs.lock().expect("registry lock").remove(job_id);
        self.next_seq.lock().expect("registry lock").remove(job_id);
        self.reports.lock().expect("registry lock").remove(job_id);
    }

    pub fn tools(&self, job_id: &str) -> Option<JobTools> {
        self.jobs
            .lock()
            .expect("registry lock")
            .get(job_id)
            .map(|registered| registered.tools.clone())
    }

    pub fn running_jobs(&self) -> Vec<String> {
        self.jobs
            .lock()
            .expect("registry lock")
            .keys()
            .cloned()
            .collect()
    }

    fn authenticate(&self, job_id: &str, token: &str) -> bool {
        self.jobs
            .lock()
            .expect("registry lock")
            .get(job_id)
            .is_some_and(|registered| registered.token == token)
    }
}

pub struct McpServer {
    pub addr: SocketAddr,
    pub registry: Arc<Registry>,
}

impl McpServer {
    pub async fn bind(registry: Arc<Registry>) -> std::io::Result<McpServer> {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
        let addr = listener.local_addr()?;
        let accept_registry = Arc::clone(&registry);
        tokio::spawn(async move {
            loop {
                let Ok((stream, _peer)) = listener.accept().await else {
                    break;
                };
                let connection_registry = Arc::clone(&accept_registry);
                tokio::spawn(async move {
                    let _ = serve_connection(connection_registry, stream).await;
                });
            }
        });
        Ok(McpServer { addr, registry })
    }

    pub fn endpoint(&self) -> String {
        self.addr.to_string()
    }
}

async fn serve_connection(registry: Arc<Registry>, stream: TcpStream) -> std::io::Result<()> {
    let (read_half, mut write_half) = stream.into_split();
    let mut reader = BufReader::new(read_half);
    let mut line = String::new();
    if reader.read_line(&mut line).await? == 0 {
        return Ok(());
    }
    let auth: Value = serde_json::from_str(line.trim_end()).unwrap_or(Value::Null);
    let job_id = auth
        .get("jobId")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let token = auth
        .get("token")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if auth.get("type").and_then(Value::as_str) != Some("auth")
        || !validate_job_id(job_id)
        || !registry.authenticate(job_id, token)
    {
        let reply = json!({"type": "auth", "ok": false, "error": "invalid job token"});
        write_half
            .write_all(format!("{reply}\n").as_bytes())
            .await?;
        return Ok(());
    }
    write_half
        .write_all(b"{\"type\":\"auth\",\"ok\":true}\n")
        .await?;
    let Some(tools) = registry.tools(job_id) else {
        return Ok(());
    };
    loop {
        line.clear();
        if reader.read_line(&mut line).await? == 0 {
            return Ok(());
        }
        let request: Value = match serde_json::from_str(line.trim_end()) {
            Ok(request) => request,
            Err(error) => {
                let reply = json!({"type": "result", "id": null, "ok": false, "error": format!("invalid request: {error}")});
                write_half
                    .write_all(format!("{reply}\n").as_bytes())
                    .await?;
                continue;
            }
        };
        let id = request.get("id").cloned().unwrap_or(Value::Null);
        let tool = request
            .get("tool")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let args = request.get("args").cloned().unwrap_or_else(|| json!({}));
        let reply = match call_tool(&registry, &tools, tool, &args).await {
            Ok(result) => json!({"type": "result", "id": id, "ok": true, "result": result}),
            Err(error) => json!({"type": "result", "id": id, "ok": false, "error": error}),
        };
        write_half
            .write_all(format!("{reply}\n").as_bytes())
            .await?;
    }
}

fn required_str(args: &Value, key: &str) -> Result<String, String> {
    args.get(key)
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| format!("missing string argument {key}"))
}

pub async fn call_tool(
    registry: &Registry,
    tools: &JobTools,
    tool: &str,
    args: &Value,
) -> Result<Value, String> {
    match tool {
        "repo_outline" => {
            let index = build_index(tools)?;
            let path = args.get("path").and_then(Value::as_str);
            let entries = index.outline(path).map_err(|error| error.to_string())?;
            serde_json::to_value(entries).map_err(|error| error.to_string())
        }
        "repo_search" => {
            let query = required_str(args, "query")?;
            let limit = args
                .get("limit")
                .and_then(Value::as_u64)
                .unwrap_or(50)
                .clamp(1, 500) as usize;
            let index = build_index(tools)?;
            match args.get("mode").and_then(Value::as_str).unwrap_or("prefix") {
                "prefix" => serde_json::to_value(index.search(&query, limit))
                    .map_err(|error| error.to_string()),
                "regex" => {
                    let hits = index
                        .grep(&query, limit)
                        .map_err(|error| error.to_string())?;
                    serde_json::to_value(hits).map_err(|error| error.to_string())
                }
                other => Err(format!("unknown search mode {other}")),
            }
        }
        "repo_snippet" => {
            let path = required_str(args, "path")?;
            let start = args
                .get("startLine")
                .and_then(Value::as_u64)
                .map(|line| line as u32);
            let end = args
                .get("endLine")
                .and_then(Value::as_u64)
                .map(|line| line as u32);
            let index = build_index(tools)?;
            serde_json::to_value(
                index
                    .snippet(&path, start, end)
                    .map_err(|error| error.to_string())?,
            )
            .map_err(|error| error.to_string())
        }
        "gate_run" => {
            let spec: GateSpec = serde_json::from_value(args.clone())
                .map_err(|error| format!("invalid gate_run arguments: {error}"))?;
            let outcome = verify::run_gate(&tools.worktree, &spec)
                .await
                .map_err(|error| error.to_string())?;
            verify::record_gate(&tools.evidence_dir, &outcome)
                .map_err(|error| error.to_string())?;
            serde_json::to_value(outcome).map_err(|error| error.to_string())
        }
        "claim_verify" => {
            let claim: Claim = serde_json::from_value(args.clone())
                .map_err(|error| format!("invalid claim_verify arguments: {error}"))?;
            let outcome = verify::verify_claim(&tools.worktree, &claim)
                .await
                .map_err(|error| error.to_string())?;
            verify::record_claim(&tools.evidence_dir, &outcome)
                .map_err(|error| error.to_string())?;
            serde_json::to_value(outcome).map_err(|error| error.to_string())
        }
        "diff_summary" => {
            let base = args.get("base").and_then(Value::as_str);
            let summary =
                verify::diff_summary(&tools.worktree, base).map_err(|error| error.to_string())?;
            serde_json::to_value(summary).map_err(|error| error.to_string())
        }
        "submit_intent_card" => {
            validate_card(args)?;
            registry.update_report(&tools.job_id, |report| report.card = Some(args.clone()));
            Ok(json!({"accepted": "intent_card"}))
        }
        "submit_spec" => {
            let body = required_str(args, "bodyMd")?;
            if body.len() > 24 * 1024 {
                return Err("bodyMd must stay under 24 KB".to_string());
            }
            registry.update_report(&tools.job_id, |report| report.spec = Some(body.clone()));
            registry.emit(RunnerMessage::JobSpec(JobSpecMessage {
                job_id: tools.job_id.clone(),
                seq: None,
                body_md: body,
            }));
            Ok(json!({"accepted": "spec"}))
        }
        "submit_plan" => {
            let plan = args
                .get("plan")
                .filter(|plan| plan.is_object())
                .cloned()
                .ok_or_else(|| "plan must be an object".to_string())?;
            registry.update_report(&tools.job_id, |report| report.plan = Some(plan));
            Ok(json!({"accepted": "plan"}))
        }
        "submit_report" => {
            if !args.is_object() {
                return Err("report must be an object".to_string());
            }
            registry.update_report(&tools.job_id, |report| {
                report.report = Some(args.clone());
            });
            Ok(json!({"accepted": "report"}))
        }
        "submit_findings" => {
            let findings = args
                .get("findings")
                .and_then(Value::as_array)
                .filter(|findings| !findings.is_empty())
                .cloned()
                .ok_or_else(|| "findings must be a non-empty array".to_string())?;
            validate_findings(&findings)?;
            let role = review_role(tools)?;
            registry.update_report(&tools.job_id, |report| {
                report.findings = Some(Value::Array(findings.clone()));
            });
            registry.emit(RunnerMessage::JobFindings(JobFindings {
                job_id: tools.job_id.clone(),
                seq: None,
                role,
                findings: Value::Array(findings),
            }));
            Ok(json!({"accepted": "findings"}))
        }
        "submit_verdict" => {
            let decision = required_str(args, "decision")?;
            if !matches!(decision.as_str(), "approve" | "changes" | "block") {
                return Err("decision must be approve, changes or block".to_string());
            }
            let artifact_sha256 = match args.get("artifactSha256") {
                None | Some(Value::Null) => None,
                Some(Value::String(sha))
                    if sha.len() == 64 && sha.chars().all(|c| c.is_ascii_hexdigit()) =>
                {
                    Some(sha.clone())
                }
                Some(_) => return Err("artifactSha256 must be 64 hex characters".to_string()),
            };
            let role = review_role(tools)?;
            registry.update_report(&tools.job_id, |report| {
                report.verdict = Some(json!({
                    "decision": decision,
                    "artifactSha256": artifact_sha256,
                }));
            });
            registry.emit(RunnerMessage::JobVerdict(JobVerdict {
                job_id: tools.job_id.clone(),
                seq: None,
                role,
                decision,
                artifact_sha256,
            }));
            Ok(json!({"accepted": "verdict"}))
        }
        other => Err(format!("unknown tool {other}")),
    }
}

fn review_role(tools: &JobTools) -> Result<String, String> {
    tools
        .role
        .clone()
        .ok_or_else(|| "findings and verdicts are only accepted for review stages".to_string())
}

fn validate_card(card: &Value) -> Result<(), String> {
    let object = card.as_object().ok_or("intent card must be an object")?;
    let objective = object
        .get("objective")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if objective.is_empty() {
        return Err("intent card objective is required".to_string());
    }
    for key in [
        "users",
        "jobs",
        "inScope",
        "outOfScope",
        "constraints",
        "successSignals",
        "assumptions",
        "risks",
        "openQuestions",
    ] {
        let list = object
            .get(key)
            .and_then(Value::as_array)
            .ok_or_else(|| format!("intent card {key} must be an array"))?;
        if list.iter().any(|item| item.as_str().is_none()) {
            return Err(format!("intent card {key} must contain strings"));
        }
    }
    Ok(())
}

fn validate_findings(findings: &[Value]) -> Result<(), String> {
    for finding in findings {
        let object = finding.as_object().ok_or("a finding must be an object")?;
        let class = object
            .get("class")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if !matches!(
            class,
            "ambiguous"
                | "missing-evidence"
                | "contradiction"
                | "unprovable"
                | "stale-doc"
                | "scope"
        ) {
            return Err(format!("unknown finding class {class}"));
        }
        let severity = object
            .get("severity")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if !matches!(severity, "blocking" | "nit") {
            return Err(format!("unknown finding severity {severity}"));
        }
        if object
            .get("requirement")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .is_empty()
        {
            return Err("a finding needs a requirement".to_string());
        }
    }
    Ok(())
}

fn build_index(tools: &JobTools) -> Result<Index, String> {
    let tree_hash = git::tree_hash_at(&tools.worktree).map_err(|error| error.to_string())?;
    Index::build(&tools.worktree, &tree_hash).map_err(|error| error.to_string())
}

pub fn tool_definitions() -> Value {
    json!([
        {
            "name": "repo_outline",
            "description": "Symbol outline of the worktree, optionally for one path.",
            "inputSchema": {
                "type": "object",
                "properties": {"path": {"type": "string"}},
                "additionalProperties": false
            }
        },
        {
            "name": "repo_search",
            "description": "Search symbols by name prefix, or grep lines by regular expression.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "query": {"type": "string"},
                    "mode": {"type": "string", "enum": ["prefix", "regex"]},
                    "limit": {"type": "integer", "minimum": 1, "maximum": 500}
                },
                "required": ["query"],
                "additionalProperties": false
            }
        },
        {
            "name": "repo_snippet",
            "description": "Read at most 80 numbered lines from a source file in the worktree.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "path": {"type": "string"},
                    "startLine": {"type": "integer", "minimum": 1},
                    "endLine": {"type": "integer", "minimum": 1}
                },
                "required": ["path"],
                "additionalProperties": false
            }
        },
        {
            "name": "gate_run",
            "description": "Run one project gate in the worktree; returns exit status and a 4KB output tail.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "criterion": {"type": "string"},
                    "command": {"type": "array", "items": {"type": "string"}, "minItems": 1},
                    "cwd": {"type": "string"},
                    "timeoutSeconds": {"type": "integer", "minimum": 1, "maximum": 86400}
                },
                "required": ["criterion", "command"],
                "additionalProperties": false
            }
        },
        {
            "name": "claim_verify",
            "description": "Verify a claim against the current worktree: file line, symbol or command.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "id": {"type": "string"},
                    "blobSha": {"type": "string"},
                    "probe": {"type": "object"}
                },
                "required": ["id", "probe"],
                "additionalProperties": false
            }
        },
        {
            "name": "diff_summary",
            "description": "Files, additions, deletions and status versus HEAD (or a base commit); no content.",
            "inputSchema": {
                "type": "object",
                "properties": {"base": {"type": "string"}},
                "additionalProperties": false
            }
        },
        {
            "name": "submit_intent_card",
            "description": "Report the structured intent card of this intake stage.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "objective": {"type": "string"},
                    "users": {"type": "array", "items": {"type": "string"}},
                    "jobs": {"type": "array", "items": {"type": "string"}},
                    "inScope": {"type": "array", "items": {"type": "string"}},
                    "outOfScope": {"type": "array", "items": {"type": "string"}},
                    "constraints": {"type": "array", "items": {"type": "string"}},
                    "successSignals": {"type": "array", "items": {"type": "string"}},
                    "assumptions": {"type": "array", "items": {"type": "string"}},
                    "risks": {"type": "array", "items": {"type": "string"}},
                    "openQuestions": {"type": "array", "items": {"type": "string"}}
                },
                "required": [
                    "objective",
                    "users",
                    "jobs",
                    "inScope",
                    "outOfScope",
                    "constraints",
                    "successSignals",
                    "assumptions",
                    "risks",
                    "openQuestions"
                ],
                "additionalProperties": false
            }
        },
        {
            "name": "submit_spec",
            "description": "Submit the markdown spec of this spec stage.",
            "inputSchema": {
                "type": "object",
                "properties": {"bodyMd": {"type": "string", "minLength": 1, "maxLength": 24576}},
                "required": ["bodyMd"],
                "additionalProperties": false
            }
        },
        {
            "name": "submit_plan",
            "description": "Submit the build plan of this plan stage.",
            "inputSchema": {
                "type": "object",
                "properties": {"plan": {"type": "object"}},
                "required": ["plan"],
                "additionalProperties": false
            }
        },
        {
            "name": "submit_report",
            "description": "Submit the gate and claim report of this verify stage.",
            "inputSchema": {"type": "object"}
        },
        {
            "name": "submit_findings",
            "description": "Submit review findings of this spec_critic or review stage.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "findings": {
                        "type": "array",
                        "minItems": 1,
                        "items": {
                            "type": "object",
                            "properties": {
                                "acId": {"type": "string"},
                                "class": {
                                    "type": "string",
                                    "enum": ["ambiguous", "missing-evidence", "contradiction", "unprovable", "stale-doc", "scope"]
                                },
                                "severity": {"type": "string", "enum": ["blocking", "nit"]},
                                "requirement": {"type": "string"},
                                "evidence": {"type": "string"},
                                "requiredChange": {"type": "string"}
                            },
                            "required": ["class", "severity", "requirement"],
                            "additionalProperties": false
                        }
                    }
                },
                "required": ["findings"],
                "additionalProperties": false
            }
        },
        {
            "name": "submit_verdict",
            "description": "Submit the verdict of this spec_critic or review stage.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "decision": {"type": "string", "enum": ["approve", "changes", "block"]},
                    "artifactSha256": {"type": "string", "pattern": "^[a-f0-9]{64}$"}
                },
                "required": ["decision"],
                "additionalProperties": false
            }
        }
    ])
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn local_auth(
        stream: &mut TcpStream,
        job_id: &str,
        token: &str,
    ) -> std::io::Result<bool> {
        let request = json!({"type": "auth", "jobId": job_id, "token": token});
        stream.write_all(format!("{request}\n").as_bytes()).await?;
        let mut reader = BufReader::new(stream);
        let mut line = String::new();
        reader.read_line(&mut line).await?;
        let reply: Value = serde_json::from_str(line.trim_end()).unwrap_or(Value::Null);
        Ok(reply.get("ok").and_then(Value::as_bool).unwrap_or(false))
    }

    fn worktree() -> (tempfile::TempDir, JobTools) {
        let dir = tempfile::tempdir().unwrap();
        crate::git::tests_support::init_repo(dir.path());
        std::fs::write(dir.path().join("lib.ts"), "export function find_me() {}\n").unwrap();
        crate::git::tests_support::run(dir.path(), &["add", "."]);
        crate::git::tests_support::run(dir.path(), &["commit", "-q", "-m", "lib"]);
        let repo_root = dir.path().canonicalize().unwrap();
        let tools = JobTools {
            job_id: "job-1".to_string(),
            worktree: repo_root.clone(),
            evidence_dir: repo_root.join(".intentra/evidence/job-1"),
            repo_root,
            role: None,
        };
        (dir, tools)
    }

    #[tokio::test]
    async fn registry_requires_the_job_token() {
        let (_dir, tools) = worktree();
        let registry = Registry::new();
        let token = registry.register("job-1", tools);
        assert!(registry.authenticate("job-1", &token));
        assert!(!registry.authenticate("job-1", "wrong"));
        assert!(!registry.authenticate("job-2", &token));
        registry.unregister("job-1");
        assert!(registry.tools("job-1").is_none());
    }

    #[tokio::test]
    async fn local_tools_answer_over_a_real_socket() {
        let (_dir, tools) = worktree();
        let registry = Registry::new();
        let token = registry.register("job-1", tools.clone());
        let server = McpServer::bind(Arc::clone(&registry)).await.unwrap();
        let mut stream = TcpStream::connect(server.addr).await.unwrap();
        assert!(local_auth(&mut stream, "job-1", &token).await.unwrap());
        drop(stream);
        let outline = call_tool(&registry, &tools, "repo_outline", &json!({}))
            .await
            .unwrap();
        assert!(outline.to_string().contains("find_me"));
        let search = call_tool(&registry, &tools, "repo_search", &json!({"query": "find"}))
            .await
            .unwrap();
        assert!(search.to_string().contains("find_me"));
        let diff = call_tool(&registry, &tools, "diff_summary", &json!({}))
            .await
            .unwrap();
        assert_eq!(diff["files"], 0);
        assert!(
            call_tool(&registry, &tools, "made_up", &json!({}))
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn a_bad_token_is_refused_before_any_tool_call() {
        let (_dir, tools) = worktree();
        let registry = Registry::new();
        registry.register("job-1", tools);
        let server = McpServer::bind(Arc::clone(&registry)).await.unwrap();
        let mut stream = TcpStream::connect(server.addr).await.unwrap();
        assert!(!local_auth(&mut stream, "job-1", "nope").await.unwrap());
    }

    #[test]
    fn tool_definitions_are_json_schemas() {
        let definitions = tool_definitions();
        let array = definitions.as_array().expect("tool definitions is a list");
        assert_eq!(array.len(), 12);
        for definition in array {
            assert!(definition["name"].is_string());
            assert_eq!(definition["inputSchema"]["type"], "object");
        }
    }

    #[test]
    fn unregistered_jobs_have_no_tools() {
        let registry = Registry::new();
        assert!(registry.tools("job-1").is_none());
        assert!(registry.running_jobs().is_empty());
    }
}
