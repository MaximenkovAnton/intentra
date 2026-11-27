use std::sync::Arc;

use crate::adapter::{
    AdapterCapabilities, AdapterError, AdapterFuture, AdapterHost, AgentAdapter, AgentEvent,
    AgentResult, DetectResult, JobSpec, NoHost, Usage,
};
use crate::protocol::{AdapterInfo, JobResultStatus};
use crate::util::now_iso;

pub const ID: &str = "mock";

pub struct MockAdapter {
    host: Arc<dyn AdapterHost>,
}

impl Default for MockAdapter {
    fn default() -> Self {
        MockAdapter {
            host: Arc::new(NoHost),
        }
    }
}

impl MockAdapter {
    pub fn with_host(host: Arc<dyn AdapterHost>) -> MockAdapter {
        MockAdapter { host }
    }
}

impl AgentAdapter for MockAdapter {
    fn info(&self) -> AdapterInfo {
        AdapterInfo {
            id: ID.to_string(),
            label: "Mock".to_string(),
        }
    }

    fn capabilities(&self) -> AdapterCapabilities {
        AdapterCapabilities {
            sessions: true,
            streaming: true,
            user_questions: true,
            model_selection: true,
            ..AdapterCapabilities::default()
        }
    }

    fn detect<'a>(&'a self) -> AdapterFuture<'a, DetectResult> {
        Box::pin(async { DetectResult::available(env!("CARGO_PKG_VERSION")) })
    }

    fn run<'a>(&'a self, spec: JobSpec) -> AdapterFuture<'a, Result<AgentResult, AdapterError>> {
        Box::pin(async move {
            let at = now_iso();
            self.host.event(
                &spec.id,
                AgentEvent::Status {
                    state: "running".to_string(),
                    at: at.clone(),
                },
            );
            self.host.event(
                &spec.id,
                AgentEvent::Tool {
                    name: "mock".to_string(),
                    status: "started".to_string(),
                    at: at.clone(),
                },
            );
            let marker = format!(
                "intentra mock agent\nintentId: {}\nstage: {}\n",
                spec.intent_id, spec.stage
            );
            tokio::fs::write(spec.cwd.join("agent-output.txt"), marker)
                .await
                .map_err(|error| AdapterError::new(ID, error.to_string()))?;
            self.host.event(
                &spec.id,
                AgentEvent::Tool {
                    name: "mock".to_string(),
                    status: "finished".to_string(),
                    at: at.clone(),
                },
            );
            self.host.event(
                &spec.id,
                AgentEvent::Usage {
                    input_tokens: Some(1),
                    output_tokens: Some(1),
                    at: at.clone(),
                },
            );
            self.host.event(
                &spec.id,
                AgentEvent::Status {
                    state: "idle".to_string(),
                    at,
                },
            );
            Ok(AgentResult {
                status: JobResultStatus::Succeeded,
                summary: Some("mock agent completed".to_string()),
                findings: None,
                verdict: None,
                usage: Usage {
                    input_tokens: Some(1),
                    output_tokens: Some(1),
                },
                links: Vec::new(),
            })
        })
    }

    fn cancel<'a>(&'a self, _job_id: &'a str) -> AdapterFuture<'a, ()> {
        Box::pin(async {})
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::adapter::{JobLimits, McpEndpoint, Permission};
    use std::collections::BTreeMap;
    use std::sync::Mutex;

    #[derive(Default)]
    struct RecordingHost {
        events: Mutex<Vec<AgentEvent>>,
    }

    impl AdapterHost for RecordingHost {
        fn event(&self, _job_id: &str, event: AgentEvent) {
            self.events.lock().unwrap().push(event);
        }

        fn ask<'a>(
            &'a self,
            _job_id: &'a str,
            _question: serde_json::Value,
        ) -> AdapterFuture<'a, Option<serde_json::Value>> {
            Box::pin(async { None })
        }
    }

    fn spec(cwd: std::path::PathBuf) -> JobSpec {
        JobSpec {
            id: "job-1".to_string(),
            intent_id: "intent-1".to_string(),
            stage: "build".to_string(),
            prompt: "do it".to_string(),
            context: serde_json::Value::Null,
            cwd,
            limits: JobLimits {
                timeout_seconds: 60,
            },
            tools: McpEndpoint {
                socket: "127.0.0.1:1234".to_string(),
                token: "job-token".to_string(),
            },
            model: None,
            permission: Permission::WorkspaceWrite,
            env: BTreeMap::new(),
        }
    }

    #[tokio::test]
    async fn the_mock_adapter_writes_into_the_worktree() {
        let dir = tempfile::tempdir().unwrap();
        let adapter = MockAdapter::default();
        let result = adapter.run(spec(dir.path().to_path_buf())).await.unwrap();
        assert_eq!(result.status, JobResultStatus::Succeeded);
        assert_eq!(result.summary.as_deref(), Some("mock agent completed"));
        let body = std::fs::read_to_string(dir.path().join("agent-output.txt")).unwrap();
        assert!(body.contains("intent-1"));
    }

    #[tokio::test]
    async fn the_mock_adapter_emits_the_same_events_every_run() {
        let dir = tempfile::tempdir().unwrap();
        let host = Arc::new(RecordingHost::default());
        let adapter = MockAdapter::with_host(host.clone());
        adapter.run(spec(dir.path().to_path_buf())).await.unwrap();
        let first = host.events.lock().unwrap().clone();
        host.events.lock().unwrap().clear();
        adapter.run(spec(dir.path().to_path_buf())).await.unwrap();
        let second = host.events.lock().unwrap().clone();
        let shape = |events: &[AgentEvent]| {
            events
                .iter()
                .map(|event| match event {
                    AgentEvent::Status { state, .. } => format!("status:{state}"),
                    AgentEvent::Tool { name, status, .. } => format!("tool:{name}:{status}"),
                    AgentEvent::Usage { .. } => "usage".to_string(),
                    AgentEvent::Question { .. } => "question".to_string(),
                    AgentEvent::Log { .. } => "log".to_string(),
                })
                .collect::<Vec<_>>()
        };
        assert_eq!(
            shape(&first),
            vec![
                "status:running",
                "tool:mock:started",
                "tool:mock:finished",
                "usage",
                "status:idle",
            ]
        );
        assert_eq!(shape(&second), shape(&first));
    }
}
