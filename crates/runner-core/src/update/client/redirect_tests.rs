use std::net::SocketAddr;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use rustls::ServerConfig;
use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio_rustls::TlsAcceptor;

use super::stub::{StubCenter, StubResponse};
use super::{UpdateClient, UpdateClientError};
use crate::config::Channel;

const CERT_DER: &[u8] = include_bytes!("fixtures/tls-cert.der");
const KEY_DER: &[u8] = include_bytes!("fixtures/tls-key.der");
const NO_UPDATE_JSON: &str = r#"{"available":false,"channel":"stable","latestVersion":null,"pinnedVersion":null,"autoUpdate":true,"reason":"no newer version"}"#;

struct TlsResponse {
    status: u16,
    location: Option<String>,
    body: Vec<u8>,
}

impl TlsResponse {
    fn head(&self) -> String {
        let reason = match self.status {
            200 => "OK",
            302 => "Found",
            _ => "Error",
        };
        let mut head = format!(
            "HTTP/1.1 {} {reason}\r\ncontent-type: application/json\r\ncontent-length: {}\r\n",
            self.status,
            self.body.len()
        );
        if let Some(location) = &self.location {
            head.push_str(&format!("location: {location}\r\n"));
        }
        head.push_str("connection: close\r\n\r\n");
        head
    }
}

fn server_config() -> Arc<ServerConfig> {
    let certificate = CertificateDer::from(CERT_DER.to_vec());
    let key = PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(KEY_DER.to_vec()));
    Arc::new(
        ServerConfig::builder()
            .with_no_client_auth()
            .with_single_cert(vec![certificate], key)
            .expect("the committed test certificate matches its key"),
    )
}

fn spawn_tls(listener: TcpListener, responses: Vec<TlsResponse>) -> Arc<Mutex<Vec<String>>> {
    let acceptor = TlsAcceptor::from(server_config());
    let requests = Arc::new(Mutex::new(Vec::new()));
    let recorded = Arc::clone(&requests);
    tokio::spawn(async move {
        for response in responses {
            let Ok((stream, _)) = listener.accept().await else {
                return;
            };
            let Ok(mut stream) = acceptor.accept(stream).await else {
                continue;
            };
            if let Some(request) = read_request_line(&mut stream).await {
                recorded.lock().unwrap().push(request);
            }
            let _ = stream.write_all(response.head().as_bytes()).await;
            let _ = stream.write_all(&response.body).await;
            let _ = stream.shutdown().await;
        }
    });
    requests
}

async fn read_request_line<S: AsyncRead + Unpin>(stream: &mut S) -> Option<String> {
    let mut buffer = Vec::new();
    let mut chunk = [0u8; 4096];
    loop {
        let read = stream.read(&mut chunk).await.ok()?;
        if read == 0 {
            return None;
        }
        buffer.extend_from_slice(&chunk[..read]);
        if let Some(end) = buffer.windows(4).position(|window| window == b"\r\n\r\n") {
            let head = String::from_utf8_lossy(&buffer[..end]).to_string();
            return head.lines().next().map(str::to_string);
        }
    }
}

async fn bind_tls() -> (TcpListener, SocketAddr) {
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let addr = listener.local_addr().unwrap();
    (listener, addr)
}

fn client(server_url: &str, allow_insecure_http: bool) -> UpdateClient {
    let root = reqwest::Certificate::from_der(CERT_DER)
        .expect("the committed test certificate parses as DER");
    UpdateClient {
        http: super::build_http(allow_insecure_http, Some(root)).unwrap(),
        endpoints: super::UpdateEndpoints::derive(server_url, allow_insecure_http).unwrap(),
        token: "runner-secret".to_string(),
    }
}

#[tokio::test]
async fn refuses_an_https_to_http_redirect() {
    let http_listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let http_addr = http_listener.local_addr().unwrap();
    let http_connections = Arc::new(AtomicUsize::new(0));
    let counter = Arc::clone(&http_connections);
    tokio::spawn(async move {
        loop {
            let Ok((stream, _)) = http_listener.accept().await else {
                return;
            };
            counter.fetch_add(1, Ordering::SeqCst);
            drop(stream);
        }
    });

    let (listener, addr) = bind_tls().await;
    let requests = spawn_tls(
        listener,
        vec![TlsResponse {
            status: 302,
            location: Some(format!(
                "http://127.0.0.1:{}/api/runners/update",
                http_addr.port()
            )),
            body: Vec::new(),
        }],
    );
    let error = client(&format!("wss://127.0.0.1:{}", addr.port()), false)
        .update("0.1.0", Channel::Stable)
        .await
        .unwrap_err();
    let UpdateClientError::Request(error) = error else {
        panic!("unexpected error: {error:?}");
    };
    assert!(error.is_redirect(), "{error}");
    assert_eq!(
        error.url().map(|url| url.scheme()),
        Some("http"),
        "{error:?}"
    );
    assert_eq!(
        http_connections.load(Ordering::SeqCst),
        0,
        "the client must not connect to the plain http redirect target"
    );
    assert_eq!(requests.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn follows_an_https_to_https_redirect() {
    let (target_listener, target_addr) = bind_tls().await;
    let target_requests = spawn_tls(
        target_listener,
        vec![TlsResponse {
            status: 200,
            location: None,
            body: NO_UPDATE_JSON.as_bytes().to_vec(),
        }],
    );
    let (listener, addr) = bind_tls().await;
    let requests = spawn_tls(
        listener,
        vec![TlsResponse {
            status: 302,
            location: Some(format!(
                "https://127.0.0.1:{}/api/runners/update?current=0.1.0&channel=stable",
                target_addr.port()
            )),
            body: Vec::new(),
        }],
    );
    let update = client(&format!("wss://127.0.0.1:{}", addr.port()), false)
        .update("0.1.0", Channel::Stable)
        .await
        .unwrap();
    assert!(!update.available);
    assert_eq!(update.reason.as_deref(), Some("no newer version"));
    assert_eq!(requests.lock().unwrap().len(), 1);
    let target_requests = target_requests.lock().unwrap().clone();
    assert_eq!(target_requests.len(), 1);
    assert_eq!(
        target_requests[0],
        "GET /api/runners/update?current=0.1.0&channel=stable HTTP/1.1"
    );
}

#[tokio::test]
async fn accepts_plain_http_when_insecure_http_is_allowed() {
    let body = NO_UPDATE_JSON.as_bytes().to_vec();
    let stub = StubCenter::start(vec![StubResponse {
        status: 200,
        content_type: "application/json",
        content_length: Some(body.len()),
        body,
        hold_open: false,
    }])
    .await;
    let update = UpdateClient::new(&stub.url(), "runner-secret", true)
        .unwrap()
        .update("0.1.0", Channel::Stable)
        .await
        .unwrap();
    assert!(!update.available);
    let requests = stub.requests();
    assert_eq!(requests.len(), 1);
    assert!(requests[0].path.starts_with("/api/runners/update?"));
}
