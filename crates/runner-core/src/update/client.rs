use std::io::Write;
use std::path::Path;
use std::time::Duration;

use futures_util::StreamExt;
use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::config::Channel;
use crate::update::UpdateError;
use crate::update::manifest::{RunnerUpdate, UpdateAsset};
use crate::util::tail;

pub const ARTIFACT_MAX_BYTES: u64 = 256 * 1024 * 1024;

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

impl UpdateClient {
    pub fn new(
        server_url: &str,
        token: impl Into<String>,
        allow_insecure_http: bool,
    ) -> Result<UpdateClient, UpdateClientError> {
        Ok(UpdateClient {
            http: reqwest::Client::builder().build()?,
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
            let body = response.text().await.unwrap_or_default();
            return Err(UpdateClientError::Rejected {
                status: status.as_u16(),
                message: tail(body.trim(), 512),
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
        let body = response.text().await.unwrap_or_default();
        return Err(UpdateClientError::Rejected {
            status: status.as_u16(),
            message: tail(body.trim(), 512),
        });
    }
    Ok(response.bytes().await?.to_vec())
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
mod tests {
    use super::*;

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
}
