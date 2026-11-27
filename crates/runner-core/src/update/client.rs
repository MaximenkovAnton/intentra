use std::io::Write;
use std::path::Path;
use std::time::Duration;

use futures_util::StreamExt;
use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::config::Channel;
use crate::update::UpdateError;
use crate::update::manifest::{RunnerUpdate, UpdateAsset};
use crate::update::sanitize_for_log;
use crate::util::tail;

pub const ARTIFACT_MAX_BYTES: u64 = 256 * 1024 * 1024;
pub const JSON_MAX_BYTES: u64 = 1024 * 1024;

const ERROR_MESSAGE_MAX_CHARS: usize = 512;
const JSON_TIMEOUT: Duration = Duration::from_secs(30);
const ARTIFACT_TIMEOUT: Duration = Duration::from_secs(300);

#[derive(Debug, thiserror::Error)]
pub enum UpdateClientError {
    #[error("invalid server URL {0}")]
    Url(String),
    #[error(
        "refusing to derive a plain http update endpoint; set update.allow_insecure_http to allow it"
    )]
    InsecureHttp,
    #[error("invalid artifact file name {0}")]
    ArtifactName(String),
    #[error("cannot reach the control plane: {0}")]
    Request(#[from] reqwest::Error),
    #[error("the control plane rejected the update request with HTTP {status}: {message}")]
    Rejected { status: u16, message: String },
    #[error("the control plane response body is larger than {limit} bytes")]
    ResponseTooLarge { limit: u64 },
    #[error("the control plane returned an invalid update response: {0}")]
    Response(String),
    #[error("invalid update response: {0}")]
    Invalid(#[from] UpdateError),
    #[error("artifact is too large: {size} bytes")]
    ArtifactTooLarge { size: u64 },
    #[error("artifact digest mismatch: expected {expected}, got {actual}")]
    DigestMismatch { expected: String, actual: String },
    #[error("cannot write the staging file: {0}")]
    Io(#[from] std::io::Error),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpdateEndpoints {
    base: reqwest::Url,
}

impl UpdateEndpoints {
    pub fn derive(
        server_url: &str,
        allow_insecure_http: bool,
    ) -> Result<UpdateEndpoints, UpdateClientError> {
        let mapped = server_url
            .trim()
            .replace("wss://", "https://")
            .replace("ws://", "http://");
        let mut url = reqwest::Url::parse(&mapped)
            .map_err(|_| UpdateClientError::Url(server_url.to_string()))?;
        match url.scheme() {
            "https" => {}
            "http" if allow_insecure_http => {}
            "http" => return Err(UpdateClientError::InsecureHttp),
            _ => return Err(UpdateClientError::Url(server_url.to_string())),
        }
        url.set_path("/api/runners/update");
        url.set_query(None);
        url.set_fragment(None);
        Ok(UpdateEndpoints { base: url })
    }

    pub fn update_url(&self, current: &str, channel: Channel) -> String {
        let mut url = self.base.clone();
        url.query_pairs_mut()
            .append_pair("current", current)
            .append_pair("channel", channel.as_str());
        url.to_string()
    }

    pub fn artifact_url(&self, file_name: &str) -> Result<String, UpdateClientError> {
        validate_file_name(file_name)?;
        let mut url = self.base.clone();
        url.path_segments_mut()
            .map_err(|_| UpdateClientError::Url(self.base.to_string()))?
            .push("artifact")
            .push(file_name);
        Ok(url.to_string())
    }

    pub fn report_url(&self) -> String {
        let mut url = self.base.clone();
        if let Ok(mut segments) = url.path_segments_mut() {
            segments.push("report");
        }
        url.to_string()
    }
}

fn validate_file_name(file_name: &str) -> Result<(), UpdateClientError> {
    let valid = !file_name.is_empty()
        && !file_name.starts_with('.')
        && !file_name.contains("..")
        && file_name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'));
    if valid {
        Ok(())
    } else {
        Err(UpdateClientError::ArtifactName(file_name.to_string()))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum UpdateStatus {
    Applied,
    RolledBack,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateReport {
    pub from_version: String,
    pub to_version: String,
    pub status: UpdateStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

impl UpdateReport {
    pub fn new(
        from_version: impl Into<String>,
        to_version: impl Into<String>,
        status: UpdateStatus,
        reason: Option<String>,
    ) -> UpdateReport {
        UpdateReport {
            from_version: from_version.into(),
            to_version: to_version.into(),
            status,
            reason,
        }
    }
}

pub struct UpdateClient {
    http: reqwest::Client,
    endpoints: UpdateEndpoints,
    token: String,
}

fn build_http(
    allow_insecure_http: bool,
    root: Option<reqwest::Certificate>,
) -> Result<reqwest::Client, UpdateClientError> {
    let mut builder = reqwest::Client::builder().https_only(!allow_insecure_http);
    if let Some(root) = root {
        builder = builder.add_root_certificate(root);
    }
    Ok(builder.build()?)
}

impl UpdateClient {
    pub fn new(
        server_url: &str,
        token: impl Into<String>,
        allow_insecure_http: bool,
    ) -> Result<UpdateClient, UpdateClientError> {
        Ok(UpdateClient {
            http: build_http(allow_insecure_http, None)?,
            endpoints: UpdateEndpoints::derive(server_url, allow_insecure_http)?,
            token: token.into(),
        })
    }

    pub async fn update(
        &self,
        current: &str,
        channel: Channel,
    ) -> Result<RunnerUpdate, UpdateClientError> {
        let url = self.endpoints.update_url(current, channel);
        let response = self
            .http
            .get(url)
            .timeout(JSON_TIMEOUT)
            .bearer_auth(&self.token)
            .send()
            .await?;
        let body = success_body(response).await?;
        let update: RunnerUpdate = serde_json::from_slice(&body)
            .map_err(|error| UpdateClientError::Response(error.to_string()))?;
        update.validate()?;
        Ok(update)
    }

    pub async fn download(
        &self,
        asset: &UpdateAsset,
        staging: &Path,
    ) -> Result<(), UpdateClientError> {
        if asset.size_bytes > ARTIFACT_MAX_BYTES {
            return Err(UpdateClientError::ArtifactTooLarge {
                size: asset.size_bytes,
            });
        }
        let url = self.endpoints.artifact_url(&asset.file_name)?;
        let response = self
            .http
            .get(url)
            .timeout(ARTIFACT_TIMEOUT)
            .bearer_auth(&self.token)
            .send()
            .await?;
        let status = response.status();
        if !status.is_success() {
            let message = error_message(&read_error_body(response).await?);
            return Err(UpdateClientError::Rejected {
                status: status.as_u16(),
                message,
            });
        }
        if let Some(parent) = staging.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let result = stream_artifact(asset, response, staging).await;
        if result.is_err() {
            let _ = std::fs::remove_file(staging);
        }
        result
    }

    pub async fn report(&self, report: &UpdateReport) -> Result<(), UpdateClientError> {
        let response = self
            .http
            .post(self.endpoints.report_url())
            .timeout(JSON_TIMEOUT)
            .bearer_auth(&self.token)
            .json(report)
            .send()
            .await?;
        success_body(response).await.map(|_| ())
    }
}

async fn success_body(response: reqwest::Response) -> Result<Vec<u8>, UpdateClientError> {
    let status = response.status();
    if !status.is_success() {
        let message = error_message(&read_error_body(response).await?);
        return Err(UpdateClientError::Rejected {
            status: status.as_u16(),
            message,
        });
    }
    read_success_body(response).await
}

async fn read_success_body(response: reqwest::Response) -> Result<Vec<u8>, UpdateClientError> {
    if let Some(length) = response.content_length()
        && length > JSON_MAX_BYTES
    {
        return Err(UpdateClientError::ResponseTooLarge {
            limit: JSON_MAX_BYTES,
        });
    }
    let mut body = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        body.extend_from_slice(&chunk?);
        if body.len() as u64 > JSON_MAX_BYTES {
            return Err(UpdateClientError::ResponseTooLarge {
                limit: JSON_MAX_BYTES,
            });
        }
    }
    Ok(body)
}

async fn read_error_body(response: reqwest::Response) -> Result<Vec<u8>, UpdateClientError> {
    let mut body = Vec::new();
    let mut stream = response.bytes_stream();
    while body.len() < JSON_MAX_BYTES as usize
        && let Some(chunk) = stream.next().await
    {
        body.extend_from_slice(&chunk?);
    }
    body.truncate(JSON_MAX_BYTES as usize);
    Ok(body)
}

fn error_message(body: &[u8]) -> String {
    let text = String::from_utf8_lossy(body);
    tail(&sanitize_for_log(text.trim()), ERROR_MESSAGE_MAX_CHARS - 1)
}

async fn stream_artifact(
    asset: &UpdateAsset,
    response: reqwest::Response,
    staging: &Path,
) -> Result<(), UpdateClientError> {
    let mut file = std::fs::File::create(staging)?;
    let mut hasher = Sha256::new();
    let mut total = 0u64;
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        total += chunk.len() as u64;
        if total > asset.size_bytes || total > ARTIFACT_MAX_BYTES {
            return Err(UpdateClientError::ArtifactTooLarge { size: total });
        }
        hasher.update(&chunk);
        file.write_all(&chunk)?;
    }
    file.flush()?;
    let actual = hex(&hasher.finalize());
    if actual != asset.sha256 {
        return Err(UpdateClientError::DigestMismatch {
            expected: asset.sha256.clone(),
            actual,
        });
    }
    Ok(())
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[cfg(test)]
mod redirect_tests;
#[cfg(test)]
mod stub;

#[cfg(test)]
mod tests {
    use super::stub::{StubCenter, StubResponse};
    use super::*;

    const FIVE_SECONDS: Duration = Duration::from_secs(5);

    fn json_stub(status: u16, content_length: Option<usize>, body: Vec<u8>) -> StubResponse {
        StubResponse {
            status,
            content_type: "application/json",
            content_length,
            body,
            hold_open: true,
        }
    }

    #[test]
    fn derives_update_endpoints() {
        let remote =
            UpdateEndpoints::derive("wss://intentra.example/api/runners/ws", false).unwrap();
        assert_eq!(
            remote.update_url("0.1.0", Channel::Stable),
            "https://intentra.example/api/runners/update?current=0.1.0&channel=stable"
        );
        let local = UpdateEndpoints::derive("ws://127.0.0.1:8080", true).unwrap();
        assert_eq!(
            local.update_url("0.1.0", Channel::Stable),
            "http://127.0.0.1:8080/api/runners/update?current=0.1.0&channel=stable"
        );
        assert!(matches!(
            UpdateEndpoints::derive("ws://127.0.0.1:8080", false),
            Err(UpdateClientError::InsecureHttp)
        ));
        assert!(matches!(
            UpdateEndpoints::derive("ftp://127.0.0.1:8080", true),
            Err(UpdateClientError::Url(_))
        ));
    }

    #[test]
    fn builds_artifact_urls_and_rejects_unsafe_file_names() {
        let endpoints = UpdateEndpoints::derive("wss://intentra.example", false).unwrap();
        let file_name = "intentra-runner-0.2.0-x86_64-unknown-linux-gnu.tar.gz";
        assert_eq!(
            endpoints.artifact_url(file_name).unwrap(),
            "https://intentra.example/api/runners/update/artifact/intentra-runner-0.2.0-x86_64-unknown-linux-gnu.tar.gz"
        );
        for unsafe_name in ["../x", "/etc/passwd", ".hidden", "a\\b", "a/b"] {
            assert!(
                matches!(
                    endpoints.artifact_url(unsafe_name),
                    Err(UpdateClientError::ArtifactName(_))
                ),
                "{unsafe_name} must be rejected"
            );
        }
    }

    #[test]
    fn reports_serialize_to_the_contract_shape() {
        let report = UpdateReport::new(
            "0.1.0",
            "0.2.0",
            UpdateStatus::RolledBack,
            Some("self-check failed".to_string()),
        );
        let value = serde_json::to_value(&report).unwrap();
        assert_eq!(value["fromVersion"], "0.1.0");
        assert_eq!(value["toVersion"], "0.2.0");
        assert_eq!(value["status"], "rolled_back");
        assert_eq!(value["reason"], "self-check failed");
    }

    fn client(stub: &StubCenter) -> UpdateClient {
        UpdateClient::new(&stub.url(), "runner-secret", true).unwrap()
    }

    #[tokio::test]
    async fn rejects_a_declared_oversized_update_body() {
        assert_eq!(JSON_MAX_BYTES, 1_048_576);
        let stub = StubCenter::start(vec![json_stub(
            200,
            Some(2 * JSON_MAX_BYTES as usize),
            Vec::new(),
        )])
        .await;
        let error =
            tokio::time::timeout(FIVE_SECONDS, client(&stub).update("0.1.0", Channel::Stable))
                .await
                .expect("the declared body size is rejected before reading")
                .unwrap_err();
        assert!(matches!(
            error,
            UpdateClientError::ResponseTooLarge { limit } if limit == JSON_MAX_BYTES
        ));
    }

    #[tokio::test]
    async fn stops_a_streamed_update_body_at_the_limit() {
        let stub = StubCenter::start(vec![json_stub(
            200,
            None,
            vec![b'x'; JSON_MAX_BYTES as usize + 1],
        )])
        .await;
        let error =
            tokio::time::timeout(FIVE_SECONDS, client(&stub).update("0.1.0", Channel::Stable))
                .await
                .expect("the streamed body is stopped at the limit")
                .unwrap_err();
        assert!(matches!(
            error,
            UpdateClientError::ResponseTooLarge { limit } if limit == JSON_MAX_BYTES
        ));
    }

    #[tokio::test]
    async fn caps_the_error_body_of_a_failed_update() {
        let body: Vec<u8> = (0..JSON_MAX_BYTES as usize)
            .map(|index| if index % 2 == 0 { b'\x1b' } else { b'\x07' })
            .collect();
        let stub = StubCenter::start(vec![json_stub(
            500,
            Some(2 * JSON_MAX_BYTES as usize),
            body,
        )])
        .await;
        let error =
            tokio::time::timeout(FIVE_SECONDS, client(&stub).update("0.1.0", Channel::Stable))
                .await
                .expect("the error body is capped at the limit")
                .unwrap_err();
        match error {
            UpdateClientError::Rejected { status, message } => {
                assert_eq!(status, 500);
                assert!(
                    message.chars().count() <= 512,
                    "the message keeps {} characters",
                    message.chars().count()
                );
            }
            other => panic!("unexpected error: {other:?}"),
        }
    }

    #[tokio::test]
    async fn rejects_an_oversized_report_body() {
        let stub = StubCenter::start(vec![json_stub(
            200,
            Some(2 * JSON_MAX_BYTES as usize),
            Vec::new(),
        )])
        .await;
        let report = UpdateReport::new("0.1.0", "0.2.0", UpdateStatus::Applied, None);
        let error = tokio::time::timeout(FIVE_SECONDS, client(&stub).report(&report))
            .await
            .expect("the declared report body size is rejected before reading")
            .unwrap_err();
        assert!(matches!(
            error,
            UpdateClientError::ResponseTooLarge { limit } if limit == JSON_MAX_BYTES
        ));
    }

    #[tokio::test]
    async fn sanitizes_control_characters_in_the_error_message() {
        let body = b"\x1b]0;pwned\x07".to_vec();
        let stub = StubCenter::start(vec![json_stub(500, Some(body.len()), body)]).await;
        let error = client(&stub)
            .update("0.1.0", Channel::Stable)
            .await
            .unwrap_err();
        let display = error.to_string();
        assert!(display.starts_with("the control plane rejected the update request with HTTP 500"));
        assert!(display.contains("\\u{1b}]0;pwned\\u{7}"), "{display}");
        assert!(!display.chars().any(char::is_control), "{display}");
    }
}
