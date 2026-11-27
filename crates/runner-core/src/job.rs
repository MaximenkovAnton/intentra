use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use serde_json::{Value, json};
use tokio::sync::watch;

use crate::adapter::{
    AdapterRegistry, AgentAdapter, AgentResult, JobLimits, JobSpec, McpEndpoint, Permission,
};
use crate::adapters::host::RunnerHost;
use crate::daemon::{JobTools, McpServer};
use crate::git::{GitError, Repo, Worktree};
use crate::protocol::{
    JobDiffEntry, JobDiffSummary, JobLink, JobOffer, JobResult, JobResultStatus, JobStatus,
    JobStatusMessage, RunnerMessage,
};
use crate::util::{self, slug, validate_job_id};
use crate::verify;

pub const DEFAULT_JOB_TIMEOUT_SECONDS: u64 = 3600;

fn contract_status(status: &str) -> &str {
    match status {
        "added" | "deleted" | "renamed" => status,
        "copied" => "added",
        _ => "modified",
    }
}

#[derive(Debug, Clone)]
pub struct ExecutorConfig {
    pub roots: Vec<PathBuf>,
    pub workspaces: BTreeMap<String, PathBuf>,
    pub max_concurrent_jobs: u32,
}

#[derive(Default)]
struct JobState {
    running: HashMap<String, watch::Sender<bool>>,
    reservations: HashSet<String>,
    updating: bool,
}

pub struct JobManager {
    config: ExecutorConfig,
    adapters: AdapterRegistry,
    mcp: Arc<McpServer>,
    host: Arc<RunnerHost>,
    state: Mutex<JobState>,
}

#[derive(Clone)]
pub struct AcceptedOffer {
    pub repo: Repo,
    pub workspace: PathBuf,
    pub task: String,
    pub intent_short: String,
    pub prompt: String,
    pub timeout_seconds: u64,
    pub rework: bool,
    adapter: Arc<dyn AgentAdapter>,
}

impl std::fmt::Debug for AcceptedOffer {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("AcceptedOffer")
            .field("repo", &self.repo.root)
            .field("workspace", &self.workspace)
            .field("task", &self.task)
            .field("intent_short", &self.intent_short)
            .field("timeout_seconds", &self.timeout_seconds)
            .field("rework", &self.rework)
            .field("adapter", &self.adapter.info().id)
            .finish()
    }
}

impl JobManager {
    pub fn new(
        config: ExecutorConfig,
        adapters: AdapterRegistry,
        mcp: Arc<McpServer>,
        host: Arc<RunnerHost>,
    ) -> Arc<JobManager> {
        Arc::new(JobManager {
            config,
            adapters,
            mcp,
            host,
            state: Mutex::new(JobState::default()),
        })
    }

    pub fn answer(&self, job_id: &str, answer: Value) -> bool {
        self.host.answer(job_id, answer)
    }

    pub fn registry(&self) -> Arc<crate::daemon::Registry> {
        Arc::clone(&self.mcp.registry)
    }

    pub fn active_jobs(&self) -> u32 {
        self.state.lock().expect("job lock").running.len() as u32
    }

    pub fn running_ids(&self) -> Vec<String> {
        self.state
            .lock()
            .expect("job lock")
            .running
            .keys()
            .cloned()
            .collect()
    }

    pub fn begin_update(&self) -> bool {
        let mut state = self.state.lock().expect("job lock");
        if state.updating || !state.running.is_empty() || !state.reservations.is_empty() {
            return false;
        }
        state.updating = true;
        true
    }

    pub fn end_update(&self) {
        self.state.lock().expect("job lock").updating = false;
    }

    pub fn accept(&self, offer: &JobOffer) -> Result<AcceptedOffer, String> {
        if !validate_job_id(&offer.job_id) {
            return Err("invalid job id".to_string());
        }
        {
            let state = self.state.lock().expect("job lock");
            if state.updating {
                return Err("runner is updating".to_string());
            }
            if state.running.contains_key(&offer.job_id)
                || state.reservations.contains(&offer.job_id)
            {
                return Err("job is already running".to_string());
            }
            if state.running.len() + state.reservations.len()
                >= self.config.max_concurrent_jobs as usize
            {
                return Err("runner is busy".to_string());
            }
        }
        let lease_ok = util::parse_iso(&offer.lease_until)
            .map(|lease| lease > util::now_utc())
            .unwrap_or(false);
        if !lease_ok {
            return Err("lease expired or unparsable".to_string());
        }
        let Some(adapter) = self.adapters.select(&offer.runtime) else {
            return Err(format!("no adapter for runtime {}", offer.runtime));
        };
        let payload = &offer.payload;
        let workspace = payload
            .get("workspace")
            .and_then(Value::as_str)
            .map(str::to_string)
            .or_else(|| {
                payload
                    .get("projectKey")
                    .and_then(Value::as_str)
                    .and_then(|key| self.config.workspaces.get(key))
                    .map(|path| path.display().to_string())
            })
            .ok_or_else(|| "offer names no workspace".to_string())?;
        let repo = Repo::open(&PathBuf::from(&workspace), &self.config.roots)
            .map_err(|error| error.to_string())?;
        repo.ensure_clean().map_err(|error| error.to_string())?;
        let task = payload
            .get("task")
            .and_then(Value::as_str)
            .map(slug)
            .filter(|task| !task.is_empty())
            .unwrap_or_else(|| "task".to_string());
        let intent_short = payload
            .get("intentShort")
            .and_then(Value::as_str)
            .map(slug)
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| slug(&offer.intent_id));
        let prompt = payload
            .get("prompt")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let timeout_seconds = payload
            .get("timeoutSeconds")
            .and_then(Value::as_u64)
            .or_else(|| {
                payload
                    .get("limits")
                    .and_then(|limits| limits.get("timeoutSeconds"))
                    .and_then(Value::as_u64)
            })
            .unwrap_or(DEFAULT_JOB_TIMEOUT_SECONDS);
        let rework = payload
            .get("rework")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        {
            let mut state = self.state.lock().expect("job lock");
            if state.updating {
                return Err("runner is updating".to_string());
            }
            if state.running.len() + state.reservations.len()
                >= self.config.max_concurrent_jobs as usize
            {
                return Err("runner is busy".to_string());
            }
            if !state.reservations.insert(offer.job_id.clone()) {
                return Err("job is already running".to_string());
            }
        }
        Ok(AcceptedOffer {
            repo,
            workspace: PathBuf::from(workspace),
            task,
            intent_short,
            prompt,
            timeout_seconds,
            rework,
            adapter,
        })
    }

    pub fn spawn(self: &Arc<Self>, offer: JobOffer, accepted: AcceptedOffer) {
        let (cancel_tx, cancel_rx) = watch::channel(false);
        {
            let mut state = self.state.lock().expect("job lock");
            state.reservations.remove(&offer.job_id);
            state.running.insert(offer.job_id.clone(), cancel_tx);
        }
        let manager = Arc::clone(self);
        let job_id = offer.job_id.clone();
        tokio::spawn(async move {
            manager.run_job(offer, accepted, cancel_rx).await;
            manager
                .state
                .lock()
                .expect("job lock")
                .running
                .remove(&job_id);
        });
    }

    pub fn release(&self, job_id: &str) {
        self.state
            .lock()
            .expect("job lock")
            .reservations
            .remove(job_id);
    }

    pub fn cancel(&self, job_id: &str) -> bool {
        self.state
            .lock()
            .expect("job lock")
            .running
            .get(job_id)
            .map(|cancel| cancel.send(true).is_ok())
            .unwrap_or(false)
    }

    async fn run_job(
        &self,
        offer: JobOffer,
        accepted: AcceptedOffer,
        mut cancel_rx: watch::Receiver<bool>,
    ) {
        let emit = |message: RunnerMessage| self.mcp.registry.emit(message);
        emit(RunnerMessage::JobStatus(JobStatusMessage {
            job_id: offer.job_id.clone(),
            seq: None,
            status: JobStatus::Running,
            detail: None,
        }));
        let worktree =
            match accepted
                .repo
                .worktree_add(&offer.job_id, &accepted.intent_short, &accepted.task)
            {
                Ok(worktree) => worktree,
                Err(error) => {
                    tracing::warn!(job = %offer.job_id, error = %error, "worktree failed");
                    emit(RunnerMessage::JobResult(JobResult {
                        job_id: offer.job_id.clone(),
                        seq: None,
                        status: JobResultStatus::Failed,
                        result: None,
                        error: Some(error.to_string()),
                    }));
                    return;
                }
            };
        let evidence_dir = match verify::evidence_dir(&accepted.repo.root, &offer.job_id) {
            Ok(dir) => dir,
            Err(error) => {
                emit(RunnerMessage::JobResult(JobResult {
                    job_id: offer.job_id.clone(),
                    seq: None,
                    status: JobResultStatus::Failed,
                    result: None,
                    error: Some(error.to_string()),
                }));
                return;
            }
        };
        let role = match offer.stage.as_str() {
            "spec_critic" => Some("spec-critic".to_string()),
            "review" => Some("review".to_string()),
            _ => None,
        };
        let tools = JobTools {
            job_id: offer.job_id.clone(),
            worktree: worktree.path.clone(),
            repo_root: accepted.repo.root.clone(),
            evidence_dir,
            role,
        };
        let token = self.mcp.registry.register(&offer.job_id, tools);
        let spec = JobSpec {
            id: offer.job_id.clone(),
            intent_id: offer.intent_id.clone(),
            stage: offer.stage.clone(),
            prompt: accepted.prompt.clone(),
            context: offer.payload.get("context").cloned().unwrap_or(Value::Null),
            cwd: worktree.path.clone(),
            limits: JobLimits {
                timeout_seconds: accepted.timeout_seconds,
            },
            tools: McpEndpoint {
                socket: self.mcp.endpoint(),
                token,
            },
            model: offer
                .payload
                .get("model")
                .and_then(Value::as_str)
                .map(str::to_string),
            permission: Permission::WorkspaceWrite,
            env: BTreeMap::new(),
        };
        let timeout_seconds = accepted
            .timeout_seconds
            .clamp(1, verify::MAX_GATE_TIMEOUT_SECONDS);
        let timeout = std::time::Duration::from_secs(timeout_seconds);
        let outcome = tokio::select! {
            result = tokio::time::timeout(timeout, accepted.adapter.run(spec)) => Some(result),
            _ = cancel_rx.changed() => None,
        };
        let (mut status, result) = match outcome {
            Some(Ok(Ok(result))) => (result.status, Some(result)),
            Some(Ok(Err(error))) => {
                tracing::warn!(job = %offer.job_id, error = %error, "adapter failed");
                (
                    JobResultStatus::Failed,
                    Some(AgentResult {
                        status: JobResultStatus::Failed,
                        summary: Some(error.to_string()),
                        findings: None,
                        verdict: None,
                        usage: crate::adapter::Usage::default(),
                        links: Vec::new(),
                    }),
                )
            }
            Some(Err(_)) => (
                JobResultStatus::Failed,
                Some(AgentResult {
                    status: JobResultStatus::Failed,
                    summary: Some(format!("job timed out after {}s", accepted.timeout_seconds)),
                    findings: None,
                    verdict: None,
                    usage: crate::adapter::Usage::default(),
                    links: Vec::new(),
                }),
            ),
            None => {
                accepted.adapter.cancel(&offer.job_id).await;
                (JobResultStatus::Cancelled, None)
            }
        };
        let mut error = if status == JobResultStatus::Failed {
            result.as_ref().and_then(|agent| agent.summary.clone())
        } else {
            None
        };
        let (summary, finish_failed) =
            match self.finish_job(&offer, &accepted, &worktree, result).await {
                Ok(summary) => (summary, false),
                Err(finish) => {
                    status = JobResultStatus::Failed;
                    error = Some(finish.to_string());
                    (None, true)
                }
            };
        emit(RunnerMessage::JobResult(JobResult {
            job_id: offer.job_id.clone(),
            seq: None,
            status,
            result: summary,
            error,
        }));
        self.mcp.registry.unregister(&offer.job_id);
        self.host.forget(&offer.job_id);
        if !accepted.rework && !finish_failed {
            let _ = accepted.repo.worktree_remove(&worktree);
        }
    }

    async fn finish_job(
        &self,
        offer: &JobOffer,
        accepted: &AcceptedOffer,
        worktree: &Worktree,
        result: Option<AgentResult>,
    ) -> Result<Option<Value>, GitError> {
        let Some(agent) = result else {
            return Ok(None);
        };
        let commit = worktree.commit_all(&accepted.task)?;
        let diff = worktree.diff_summary(Some(&worktree.base))?;
        let tree_hash = worktree.tree_hash()?;
        let link = if agent.status == JobResultStatus::Succeeded {
            worktree.push()?
        } else {
            None
        };
        self.mcp
            .registry
            .emit(RunnerMessage::JobDiffSummary(JobDiffSummary {
                job_id: offer.job_id.clone(),
                seq: None,
                files: diff
                    .entries
                    .iter()
                    .map(|entry| JobDiffEntry {
                        path: entry.path.clone(),
                        status: contract_status(&entry.status).to_string(),
                        additions: entry.additions,
                        deletions: entry.deletions,
                        binary: entry.binary,
                    })
                    .collect(),
            }));
        if let Some(url) = &link {
            self.mcp.registry.emit(RunnerMessage::JobLink(JobLink {
                job_id: offer.job_id.clone(),
                seq: None,
                branch: Some(worktree.branch.clone()),
                commit: commit.clone(),
                pr_url: Some(url.clone()),
            }));
        }
        let report = self.mcp.registry.take_report(&offer.job_id);
        let mut result = json!({
            "summary": agent.summary,
            "branch": worktree.branch,
            "commit": commit,
            "treeHash": tree_hash,
            "diffSummary": diff,
            "link": link,
            "usage": agent.usage,
            "links": agent.links,
            "findings": agent.findings.or(report.findings),
            "verdict": agent.verdict.or(report.verdict),
            "workspace": accepted.workspace.display().to_string(),
        });
        if let Some(card) = report.card {
            result["card"] = card;
        }
        if let Some(plan) = report.plan {
            result["plan"] = plan;
        }
        if let Some(report) = report.report {
            result["report"] = report;
        }
        Ok(Some(result))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::adapters::mock::MockAdapter;
    use crate::daemon::{McpServer, Registry};
    use crate::protocol::JobOffer;

    async fn manager(max_concurrent_jobs: u32) -> (tempfile::TempDir, Arc<JobManager>) {
        let dir = tempfile::tempdir().unwrap();
        crate::git::tests_support::init_repo(dir.path());
        let root = dir.path().canonicalize().unwrap();
        let registry = Registry::new();
        let host = RunnerHost::new(Arc::clone(&registry));
        let mcp = Arc::new(McpServer::bind(registry).await.unwrap());
        let config = ExecutorConfig {
            roots: vec![root.clone()],
            workspaces: BTreeMap::from([("p".to_string(), root)]),
            max_concurrent_jobs,
        };
        (
            dir,
            JobManager::new(
                config,
                AdapterRegistry::new(vec![Arc::new(MockAdapter::default())]),
                mcp,
                host,
            ),
        )
    }

    fn offer(job_id: &str, runtime: &str, payload: Value, lease: &str) -> JobOffer {
        JobOffer {
            job_id: job_id.to_string(),
            intent_id: "intent-1".to_string(),
            stage: "build".to_string(),
            runtime: runtime.to_string(),
            payload,
            lease_until: lease.to_string(),
        }
    }

    fn lease() -> String {
        "2099-01-01T00:00:00.000Z".to_string()
    }

    #[tokio::test]
    async fn a_clean_workspace_is_accepted() {
        let (_dir, jobs) = manager(2).await;
        let accepted = jobs
            .accept(&offer(
                "job-1",
                "mock",
                json!({"projectKey": "p", "task": "Add Runner!", "intentShort": "Intent One"}),
                &lease(),
            ))
            .unwrap();
        assert_eq!(accepted.task, "add-runner");
        assert_eq!(accepted.intent_short, "intent-one");
    }

    #[tokio::test]
    async fn a_dirty_tree_is_declined() {
        let (dir, jobs) = manager(2).await;
        std::fs::write(dir.path().join("README.md"), "changed\n").unwrap();
        let error = jobs
            .accept(&offer(
                "job-1",
                "mock",
                json!({"projectKey": "p"}),
                &lease(),
            ))
            .unwrap_err();
        assert!(error.contains("dirty"), "{error}");
    }

    #[tokio::test]
    async fn a_workspace_outside_the_allowlist_is_declined() {
        let (_dir, jobs) = manager(2).await;
        let outside = tempfile::tempdir().unwrap();
        let error = jobs
            .accept(&offer(
                "job-1",
                "mock",
                json!({"workspace": outside.path().display().to_string()}),
                &lease(),
            ))
            .unwrap_err();
        assert!(error.contains("allowlist"), "{error}");
    }

    #[tokio::test]
    async fn a_missing_adapter_is_declined() {
        let (_dir, jobs) = manager(2).await;
        let error = jobs
            .accept(&offer("job-1", "dsh", json!({"projectKey": "p"}), &lease()))
            .unwrap_err();
        assert!(error.contains("no adapter"), "{error}");
    }

    #[tokio::test]
    async fn an_expired_lease_is_declined() {
        let (_dir, jobs) = manager(2).await;
        let error = jobs
            .accept(&offer(
                "job-1",
                "mock",
                json!({"projectKey": "p"}),
                "2000-01-01T00:00:00.000Z",
            ))
            .unwrap_err();
        assert!(error.contains("lease"), "{error}");
    }

    #[tokio::test]
    async fn unsafe_job_ids_are_declined() {
        let (_dir, jobs) = manager(2).await;
        let error = jobs
            .accept(&offer(
                "../escape",
                "mock",
                json!({"projectKey": "p"}),
                &lease(),
            ))
            .unwrap_err();
        assert!(error.contains("invalid job id"), "{error}");
    }

    #[tokio::test]
    async fn capacity_is_enforced() {
        let (_dir, jobs) = manager(1).await;
        let (cancel, _cancel_rx) = watch::channel(false);
        jobs.state
            .lock()
            .expect("job lock")
            .running
            .insert("job-0".to_string(), cancel);
        let error = jobs
            .accept(&offer(
                "job-1",
                "mock",
                json!({"projectKey": "p"}),
                &lease(),
            ))
            .unwrap_err();
        assert!(error.contains("busy"), "{error}");
    }

    #[tokio::test]
    async fn update_gate_is_closed_while_a_job_runs() {
        let (_dir, jobs) = manager(2).await;
        let (cancel, _cancel_rx) = watch::channel(false);
        jobs.state
            .lock()
            .expect("job lock")
            .running
            .insert("job-0".to_string(), cancel);
        assert!(!jobs.begin_update());
        jobs.state.lock().expect("job lock").running.clear();
        assert!(jobs.begin_update());
        jobs.end_update();
    }

    #[tokio::test]
    async fn update_gate_waits_for_an_accepted_offer() {
        let (_dir, jobs) = manager(2).await;
        let offer = offer("job-1", "mock", json!({"projectKey": "p"}), &lease());
        let _accepted = jobs.accept(&offer).unwrap();
        assert!(!jobs.begin_update());
        jobs.release("job-1");
        assert!(jobs.begin_update());
        jobs.end_update();
    }

    #[tokio::test]
    async fn offers_are_declined_while_updating() {
        let (_dir, jobs) = manager(2).await;
        assert!(jobs.begin_update());
        let error = jobs
            .accept(&offer(
                "job-1",
                "mock",
                json!({"projectKey": "p"}),
                &lease(),
            ))
            .unwrap_err();
        assert_eq!(error, "runner is updating");
    }

    #[tokio::test]
    async fn a_failed_commit_fails_the_job_and_keeps_its_worktree() {
        let (_dir, jobs) = manager(2).await;
        let offer = offer(
            "job-1",
            "mock",
            json!({"projectKey": "p", "task": "demo"}),
            &lease(),
        );
        let accepted = jobs.accept(&offer).unwrap();
        crate::git::tests_support::run(&accepted.repo.root, &["config", "user.name", ""]);
        let (sender, mut receiver) = tokio::sync::mpsc::channel(64);
        jobs.mcp.registry.set_outbox(sender);
        let (_cancel_tx, cancel_rx) = watch::channel(false);
        jobs.run_job(offer, accepted.clone(), cancel_rx).await;

        let mut messages = Vec::new();
        while let Ok(message) = receiver.try_recv() {
            messages.push(serde_json::to_value(message).unwrap());
        }
        let statuses: Vec<&str> = messages
            .iter()
            .filter(|message| message["type"] == "job.status")
            .filter_map(|message| message["status"].as_str())
            .collect();
        assert!(!statuses.contains(&"succeeded"), "{statuses:?}");
        let result = messages
            .iter()
            .find(|message| message["type"] == "job.result")
            .unwrap();
        assert_eq!(result["status"], "failed");
        assert!(result["result"].is_null());
        assert!(
            result["error"]
                .as_str()
                .unwrap_or_default()
                .contains("git commit -q")
        );
        let worktree = accepted
            .repo
            .root
            .join(crate::git::INTENTRA_DIR)
            .join("worktrees")
            .join("job-1");
        assert!(
            worktree.join("agent-output.txt").is_file(),
            "the agent's work was deleted"
        );
    }
}
