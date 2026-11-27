use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const PROTOCOL_VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdapterInfo {
    pub id: String,
    pub label: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Hello {
    pub protocol_version: u32,
    pub runner_version: String,
    pub os: String,
    pub arch: String,
    pub adapters: Vec<AdapterInfo>,
    pub workspaces: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Heartbeat {
    pub active_jobs: u32,
    pub last_seen_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobOffer {
    pub job_id: String,
    pub intent_id: String,
    pub stage: String,
    pub runtime: String,
    pub payload: Value,
    pub lease_until: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobAccepted {
    pub job_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobDeclined {
    pub job_id: String,
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobHeartbeat {
    pub job_id: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum JobStatus {
    Queued,
    Offered,
    Running,
    Succeeded,
    Failed,
    Cancelled,
    Expired,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobStatusMessage {
    pub job_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seq: Option<u64>,
    pub status: JobStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobEvent {
    pub job_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seq: Option<u64>,
    pub event: Value,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobDiffEntry {
    pub path: String,
    pub status: String,
    pub additions: u64,
    pub deletions: u64,
    pub binary: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffSummary {
    pub files: u64,
    pub additions: u64,
    pub deletions: u64,
    pub entries: Vec<JobDiffEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobDiffSummary {
    pub job_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seq: Option<u64>,
    pub files: Vec<JobDiffEntry>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum JobResultStatus {
    Succeeded,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobResult {
    pub job_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seq: Option<u64>,
    pub status: JobResultStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobQuestion {
    pub job_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seq: Option<u64>,
    pub question: Value,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobSpecMessage {
    pub job_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seq: Option<u64>,
    pub body_md: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobVerdict {
    pub job_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seq: Option<u64>,
    pub role: String,
    pub decision: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub artifact_sha256: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobFindings {
    pub job_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seq: Option<u64>,
    pub role: String,
    pub findings: Value,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobLink {
    pub job_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seq: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub commit: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pr_url: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryWrite {
    pub job_id: String,
    pub memory: Value,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum RunnerMessage {
    #[serde(rename = "hello")]
    Hello(Hello),
    #[serde(rename = "heartbeat")]
    Heartbeat(Heartbeat),
    #[serde(rename = "job.accept")]
    JobAccepted(JobAccepted),
    #[serde(rename = "job.declined")]
    JobDeclined(JobDeclined),
    #[serde(rename = "job.status")]
    JobStatus(JobStatusMessage),
    #[serde(rename = "job.event")]
    JobEvent(JobEvent),
    #[serde(rename = "job.findings")]
    JobFindings(JobFindings),
    #[serde(rename = "job.verdict")]
    JobVerdict(JobVerdict),
    #[serde(rename = "job.spec")]
    JobSpec(JobSpecMessage),
    #[serde(rename = "job.diff_summary")]
    JobDiffSummary(JobDiffSummary),
    #[serde(rename = "job.link")]
    JobLink(JobLink),
    #[serde(rename = "job.question")]
    JobQuestion(JobQuestion),
    #[serde(rename = "job.result")]
    JobResult(JobResult),
    #[serde(rename = "job.heartbeat")]
    JobHeartbeat(JobHeartbeat),
    #[serde(rename = "memory.write")]
    MemoryWrite(MemoryWrite),
}

impl RunnerMessage {
    pub fn job_id(&self) -> Option<&str> {
        match self {
            RunnerMessage::JobAccepted(message) => Some(&message.job_id),
            RunnerMessage::JobDeclined(message) => Some(&message.job_id),
            RunnerMessage::JobStatus(message) => Some(&message.job_id),
            RunnerMessage::JobEvent(message) => Some(&message.job_id),
            RunnerMessage::JobFindings(message) => Some(&message.job_id),
            RunnerMessage::JobVerdict(message) => Some(&message.job_id),
            RunnerMessage::JobSpec(message) => Some(&message.job_id),
            RunnerMessage::JobDiffSummary(message) => Some(&message.job_id),
            RunnerMessage::JobLink(message) => Some(&message.job_id),
            RunnerMessage::JobQuestion(message) => Some(&message.job_id),
            RunnerMessage::JobResult(message) => Some(&message.job_id),
            RunnerMessage::JobHeartbeat(message) => Some(&message.job_id),
            RunnerMessage::Hello(_)
            | RunnerMessage::Heartbeat(_)
            | RunnerMessage::MemoryWrite(_) => None,
        }
    }

    pub fn set_seq(&mut self, next: u64) {
        let slot = match self {
            RunnerMessage::JobStatus(message) => Some(&mut message.seq),
            RunnerMessage::JobEvent(message) => Some(&mut message.seq),
            RunnerMessage::JobFindings(message) => Some(&mut message.seq),
            RunnerMessage::JobVerdict(message) => Some(&mut message.seq),
            RunnerMessage::JobSpec(message) => Some(&mut message.seq),
            RunnerMessage::JobDiffSummary(message) => Some(&mut message.seq),
            RunnerMessage::JobLink(message) => Some(&mut message.seq),
            RunnerMessage::JobQuestion(message) => Some(&mut message.seq),
            RunnerMessage::JobResult(message) => Some(&mut message.seq),
            _ => None,
        };
        if let Some(seq) = slot {
            *seq = Some(next);
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobCancel {
    pub job_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobAnswer {
    pub job_id: String,
    pub answer: Value,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobContext {
    pub job_id: String,
    pub context: Value,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Ping {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ts: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenRotate {
    pub token: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum CenterMessage {
    #[serde(rename = "job.offer")]
    JobOffer(JobOffer),
    #[serde(rename = "job.cancel")]
    JobCancel(JobCancel),
    #[serde(rename = "job.answer")]
    JobAnswer(JobAnswer),
    #[serde(rename = "job.context")]
    JobContext(JobContext),
    #[serde(rename = "ping")]
    Ping(Ping),
    #[serde(rename = "token.rotate")]
    TokenRotate(TokenRotate),
}

impl CenterMessage {
    pub fn make_job_offer(offer: JobOffer) -> Self {
        CenterMessage::JobOffer(offer)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(name: &str) -> &'static str {
        match name {
            "hello.json" => include_str!("../../../fixtures/runner/hello.json"),
            "heartbeat.json" => include_str!("../../../fixtures/runner/heartbeat.json"),
            "job-offer.json" => include_str!("../../../fixtures/runner/job-offer.json"),
            "job-accept.json" => include_str!("../../../fixtures/runner/job-accept.json"),
            "job-cancel.json" => include_str!("../../../fixtures/runner/job-cancel.json"),
            "job-answer.json" => include_str!("../../../fixtures/runner/job-answer.json"),
            "job-result.json" => include_str!("../../../fixtures/runner/job-result.json"),
            other => panic!("unknown fixture {other}"),
        }
    }

    #[test]
    fn runner_fixtures_round_trip_through_the_contract() {
        for name in [
            "hello.json",
            "heartbeat.json",
            "job-accept.json",
            "job-result.json",
        ] {
            let raw = fixture(name);
            let message: RunnerMessage = serde_json::from_str(raw)
                .unwrap_or_else(|error| panic!("{name} must decode as a runner message: {error}"));
            let encoded = serde_json::to_value(&message).expect("runner message encodes");
            let original: Value = serde_json::from_str(raw).expect("fixture is JSON");
            assert_eq!(
                encoded, original,
                "{name} must round-trip byte-for-byte at the value level"
            );
        }
    }

    #[test]
    fn center_fixtures_round_trip_through_the_contract() {
        for name in ["job-offer.json", "job-cancel.json", "job-answer.json"] {
            let raw = fixture(name);
            let message: CenterMessage = serde_json::from_str(raw)
                .unwrap_or_else(|error| panic!("{name} must decode as a center message: {error}"));
            let encoded = serde_json::to_value(&message).expect("center message encodes");
            let original: Value = serde_json::from_str(raw).expect("fixture is JSON");
            assert_eq!(encoded, original, "{name} must round-trip");
        }
    }

    #[test]
    fn hello_fixture_carries_the_shared_protocol_version() {
        let RunnerMessage::Hello(hello) =
            serde_json::from_str::<RunnerMessage>(fixture("hello.json")).expect("hello parses")
        else {
            panic!("hello fixture must decode as hello");
        };
        assert_eq!(hello.protocol_version, PROTOCOL_VERSION);
        assert_eq!(hello.os, "linux");
        assert_eq!(hello.adapters[0].id, "dsh");
    }

    #[test]
    fn unknown_message_types_are_rejected() {
        assert!(serde_json::from_str::<RunnerMessage>(r#"{"type":"shutdown"}"#).is_err());
        assert!(serde_json::from_str::<CenterMessage>(r#"{"type":"shutdown"}"#).is_err());
    }
}
