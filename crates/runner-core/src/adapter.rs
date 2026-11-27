use std::collections::BTreeMap;
use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::protocol::{AdapterInfo, JobResultStatus};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdapterCapabilities {
    pub sessions: bool,
    pub streaming: bool,
    pub mcp_tools: bool,
    pub approvals: bool,
    pub user_questions: bool,
    pub model_selection: bool,
    pub resume: bool,
}

impl Default for AdapterCapabilities {
    fn default() -> Self {
        AdapterCapabilities {
            sessions: false,
            streaming: false,
            mcp_tools: true,
            approvals: false,
            user_questions: false,
            model_selection: false,
            resume: false,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum AgentEvent {
    Status {
        state: String,
        at: String,
    },
    Tool {
        name: String,
        status: String,
        at: String,
    },
    Question {
        question: Value,
    },
    Usage {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        input_tokens: Option<u64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        output_tokens: Option<u64>,
        at: String,
    },
    Log {
        message: String,
        level: String,
        at: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectResult {
    pub available: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

impl DetectResult {
    pub fn available(version: impl Into<String>) -> Self {
        DetectResult {
            available: true,
            version: Some(version.into()),
            reason: None,
        }
    }

    pub fn unavailable(reason: impl Into<String>) -> Self {
        DetectResult {
            available: false,
            version: None,
            reason: Some(reason.into()),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Permission {
    WorkspaceWrite,
    DangerFullAccess,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobLimits {
    pub timeout_seconds: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpEndpoint {
    pub socket: String,
    pub token: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobSpec {
    pub id: String,
    pub intent_id: String,
    pub stage: String,
    pub prompt: String,
    #[serde(default)]
    pub context: Value,
    pub cwd: PathBuf,
    pub limits: JobLimits,
    pub tools: McpEndpoint,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    pub permission: Permission,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_tokens: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentResult {
    pub status: JobResultStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub findings: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verdict: Option<Value>,
    #[serde(default)]
    pub usage: Usage,
    #[serde(default)]
    pub links: Vec<String>,
}

#[derive(Debug, thiserror::Error)]
#[error("adapter {adapter}: {message}")]
pub struct AdapterError {
    pub adapter: String,
    pub message: String,
}

impl AdapterError {
    pub fn new(adapter: &str, message: impl Into<String>) -> Self {
        AdapterError {
            adapter: adapter.to_string(),
            message: message.into(),
        }
    }
}

pub type AdapterFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

pub trait AgentAdapter: Send + Sync {
    fn info(&self) -> AdapterInfo;
    fn capabilities(&self) -> AdapterCapabilities;
    fn detect<'a>(&'a self) -> AdapterFuture<'a, DetectResult>;
    fn run<'a>(&'a self, spec: JobSpec) -> AdapterFuture<'a, Result<AgentResult, AdapterError>>;
    fn cancel<'a>(&'a self, job_id: &'a str) -> AdapterFuture<'a, ()>;
}

pub trait AdapterHost: Send + Sync {
    fn event(&self, job_id: &str, event: AgentEvent);
    fn ask<'a>(&'a self, job_id: &'a str, question: Value) -> AdapterFuture<'a, Option<Value>>;
}

pub struct NoHost;

impl AdapterHost for NoHost {
    fn event(&self, _job_id: &str, _event: AgentEvent) {}

    fn ask<'a>(&'a self, _job_id: &'a str, _question: Value) -> AdapterFuture<'a, Option<Value>> {
        Box::pin(async { None })
    }
}

#[derive(Default)]
pub struct AdapterRegistry {
    adapters: Vec<Arc<dyn AgentAdapter>>,
}

impl AdapterRegistry {
    pub fn new(adapters: Vec<Arc<dyn AgentAdapter>>) -> Self {
        AdapterRegistry { adapters }
    }

    pub fn register(&mut self, adapter: Arc<dyn AgentAdapter>) {
        self.adapters.push(adapter);
    }

    pub fn get(&self, id: &str) -> Option<Arc<dyn AgentAdapter>> {
        self.adapters
            .iter()
            .find(|adapter| adapter.info().id == id)
            .cloned()
    }

    pub fn select(&self, runtime: &str) -> Option<Arc<dyn AgentAdapter>> {
        let exact = self.get(runtime);
        if exact.is_some() || runtime != "dsh" {
            return exact;
        }
        self.get("cli")
    }

    pub fn infos(&self) -> Vec<AdapterInfo> {
        self.adapters.iter().map(|adapter| adapter.info()).collect()
    }

    pub fn is_empty(&self) -> bool {
        self.adapters.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn adapter_events_serialize_with_a_type_tag() {
        let event = AgentEvent::Log {
            message: "hello".to_string(),
            level: "info".to_string(),
            at: "2026-11-26T10:00:00.000Z".to_string(),
        };
        let value = serde_json::to_value(event).unwrap();
        assert_eq!(value["type"], "log");
        assert_eq!(value["message"], "hello");
    }

    #[test]
    fn an_empty_registry_selects_nothing() {
        let registry = AdapterRegistry::default();
        assert!(registry.is_empty());
        assert!(registry.select("dsh").is_none());
    }
}
