use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::token::{self, StoredToken};
use crate::util::tail;

pub const RUNNER_CAPABILITIES: &[&str] = &[
    "git",
    "tree-sitter",
    "mcp-stdio",
    "gate-run",
    "claim-verify",
];

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RegisterRequest<'a> {
    registration_token: &'a str,
    name: &'a str,
    os: &'a str,
    arch: &'a str,
    version: &'a str,
    capabilities: &'a [&'a str],
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RegisterResponse {
    runner_id: String,
    token: String,
}

#[derive(Debug, thiserror::Error)]
pub enum RegisterError {
    #[error("invalid server URL {0}")]
    Url(String),
    #[error("cannot reach the control plane: {0}")]
    Request(#[from] reqwest::Error),
    #[error("registration failed with HTTP {status}: {message}")]
    Rejected { status: u16, message: String },
    #[error("the control plane returned an invalid registration response: {0}")]
    Response(#[from] serde_json::Error),
    #[error(transparent)]
    Token(#[from] token::TokenError),
}

pub async fn register(
    server_url: &str,
    registration_token: &str,
    name: &str,
    token_path: &Path,
) -> Result<StoredToken, RegisterError> {
    let endpoint = register_endpoint(server_url)?;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()?;
    let response = client
        .post(endpoint)
        .json(&RegisterRequest {
            registration_token,
            name,
            os: std::env::consts::OS,
            arch: std::env::consts::ARCH,
            version: env!("CARGO_PKG_VERSION"),
            capabilities: RUNNER_CAPABILITIES,
        })
        .send()
        .await?;
    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(RegisterError::Rejected {
            status: status.as_u16(),
            message: tail(body.trim(), 512),
        });
    }
    let body: RegisterResponse = response.json().await?;
    let stored = StoredToken {
        runner_id: Some(body.runner_id),
        token: body.token,
    };
    token::save(token_path, &stored)?;
    Ok(stored)
}

fn register_endpoint(server_url: &str) -> Result<reqwest::Url, RegisterError> {
    let mapped = server_url
        .trim()
        .replace("wss://", "https://")
        .replace("ws://", "http://");
    let mut url =
        reqwest::Url::parse(&mapped).map_err(|_| RegisterError::Url(server_url.to_string()))?;
    match url.scheme() {
        "http" | "https" => {}
        _ => return Err(RegisterError::Url(server_url.to_string())),
    }
    url.set_path("/api/runners/register");
    url.set_query(None);
    url.set_fragment(None);
    Ok(url)
}

pub fn default_token_path() -> PathBuf {
    crate::util::expand_tilde(crate::config::DEFAULT_TOKEN_PATH)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    #[test]
    fn websocket_urls_become_rest_endpoints() {
        assert_eq!(
            register_endpoint("wss://intentra.example/api/runner")
                .unwrap()
                .as_str(),
            "https://intentra.example/api/runners/register"
        );
        assert_eq!(
            register_endpoint("ws://127.0.0.1:8080").unwrap().as_str(),
            "http://127.0.0.1:8080/api/runners/register"
        );
        assert!(register_endpoint("ftp://example.test").is_err());
    }

    #[tokio::test]
    async fn registration_stores_the_token_with_private_permissions() {
        let dir = tempfile::tempdir().unwrap();
        let token_path = dir.path().join("token");
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let addr = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut buffer = [0u8; 4096];
            let read = stream.read(&mut buffer).unwrap();
            let request = String::from_utf8_lossy(&buffer[..read]).to_string();
            assert!(request.starts_with("POST /api/runners/register "));
            assert!(request.contains("\"registrationToken\":\"reg-token\""));
            let body = r#"{"runnerId":"runner-1","token":"runner-secret"}"#;
            let response = format!(
                "HTTP/1.1 201 Created\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            stream.write_all(response.as_bytes()).unwrap();
        });
        let stored = register(
            &format!("http://{addr}"),
            "reg-token",
            "laptop",
            &token_path,
        )
        .await
        .unwrap();
        assert_eq!(stored.runner_id.as_deref(), Some("runner-1"));
        assert_eq!(token::load(&token_path).unwrap(), stored);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&token_path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        server.join().unwrap();
    }
}
