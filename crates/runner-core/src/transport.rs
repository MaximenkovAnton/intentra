use std::sync::Arc;
use std::time::Duration;

use futures_util::stream::SplitSink;
use futures_util::{SinkExt, StreamExt};
use tokio::net::TcpStream;
use tokio::sync::{Mutex, mpsc, watch};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, connect_async};

use crate::job::JobManager;
use crate::protocol::{
    AdapterInfo, CenterMessage, Heartbeat, Hello, JobAccepted, JobDeclined, JobHeartbeat,
    PROTOCOL_VERSION, RunnerMessage, TokenRotate,
};
use crate::token::{self, StoredToken};
use crate::util::now_iso;

pub const DEFAULT_HEARTBEAT_SECONDS: u64 = 30;

#[derive(Clone)]
pub struct ClientConfig {
    pub server_url: String,
    pub token: Arc<Mutex<String>>,
    pub token_path: Option<std::path::PathBuf>,
    pub runner_id: Option<String>,
    pub runner_version: String,
    pub adapters: Vec<AdapterInfo>,
    pub workspaces: Vec<String>,
    pub heartbeat_seconds: u64,
}

impl ClientConfig {
    pub fn new(
        server_url: impl Into<String>,
        token: impl Into<String>,
        workspaces: Vec<String>,
        adapters: Vec<AdapterInfo>,
    ) -> ClientConfig {
        ClientConfig {
            server_url: server_url.into(),
            token: Arc::new(Mutex::new(token.into())),
            token_path: None,
            runner_id: None,
            runner_version: env!("CARGO_PKG_VERSION").to_string(),
            adapters,
            workspaces,
            heartbeat_seconds: DEFAULT_HEARTBEAT_SECONDS,
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum TransportError {
    #[error("websocket error: {0}")]
    WebSocket(#[from] tokio_tungstenite::tungstenite::Error),
    #[error("invalid websocket request: {0}")]
    Request(#[from] tokio_tungstenite::tungstenite::http::Error),
    #[error("invalid authorization header: {0}")]
    Header(#[from] tokio_tungstenite::tungstenite::http::header::InvalidHeaderValue),
    #[error("protocol error: {0}")]
    Protocol(#[from] serde_json::Error),
}

enum SessionEnd {
    Shutdown,
    Disconnected,
}

type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;
type Sink = SplitSink<Socket, Message>;

pub async fn run(
    config: ClientConfig,
    jobs: Arc<JobManager>,
    mut shutdown: watch::Receiver<bool>,
) -> Result<(), TransportError> {
    let mut backoff = Duration::from_secs(1);
    loop {
        if *shutdown.borrow() {
            return Ok(());
        }
        let outcome = match connect(&config).await {
            Ok(socket) => {
                tracing::info!(server = %config.server_url, "runner connected");
                session(socket, &config, &jobs, shutdown.clone()).await
            }
            Err(error) => {
                tracing::warn!(error = %error, "runner cannot connect");
                Err(error)
            }
        };
        match outcome {
            Ok(SessionEnd::Shutdown) => return Ok(()),
            Ok(SessionEnd::Disconnected) => tracing::warn!("runner connection closed"),
            Err(error) => tracing::warn!(error = %error, "runner session failed"),
        }
        tokio::select! {
            _ = tokio::time::sleep(backoff) => {}
            _ = shutdown.changed() => {
                if *shutdown.borrow() {
                    return Ok(());
                }
            }
        }
        backoff = (backoff * 2).min(Duration::from_secs(30));
    }
}

async fn connect(config: &ClientConfig) -> Result<Socket, TransportError> {
    let token = config.token.lock().await.clone();
    let mut request = config.server_url.clone().into_client_request()?;
    request.headers_mut().insert(
        "authorization",
        HeaderValue::from_str(&format!("Bearer {token}"))?,
    );
    let (socket, _response) = connect_async(request).await?;
    Ok(socket)
}

async fn session(
    socket: Socket,
    config: &ClientConfig,
    jobs: &Arc<JobManager>,
    mut shutdown: watch::Receiver<bool>,
) -> Result<SessionEnd, TransportError> {
    let (mut sink, mut stream) = socket.split();
    let (outbox_tx, mut outbox_rx) = mpsc::channel::<RunnerMessage>(256);
    jobs.registry().set_outbox(outbox_tx.clone());
    send(
        &mut sink,
        &RunnerMessage::Hello(Hello {
            protocol_version: PROTOCOL_VERSION,
            runner_version: config.runner_version.clone(),
            os: std::env::consts::OS.to_string(),
            arch: std::env::consts::ARCH.to_string(),
            adapters: config.adapters.clone(),
            workspaces: config.workspaces.clone(),
        }),
    )
    .await?;
    send(&mut sink, &heartbeat(jobs)).await?;
    let interval = Duration::from_secs(config.heartbeat_seconds.max(1));
    let mut heartbeat_timer =
        tokio::time::interval_at(tokio::time::Instant::now() + interval, interval);
    loop {
        tokio::select! {
            incoming = stream.next() => {
                match incoming {
                    Some(Ok(Message::Text(text))) => {
                        let message: CenterMessage = match serde_json::from_str(text.as_str()) {
                            Ok(message) => message,
                            Err(error) => {
                                tracing::warn!(error = %error, "ignoring an unknown center message");
                                continue;
                            }
                        };
                        handle_center_message(message, config, jobs, &mut sink).await?;
                    }
                    Some(Ok(Message::Ping(payload))) => sink.send(Message::Pong(payload)).await?,
                    Some(Ok(Message::Close(_))) | None => return Ok(SessionEnd::Disconnected),
                    Some(Ok(_)) => {}
                    Some(Err(error)) => {
                        tracing::warn!(error = %error, "runner websocket read failed");
                        return Ok(SessionEnd::Disconnected);
                    }
                }
            }
            Some(outgoing) = outbox_rx.recv() => send(&mut sink, &outgoing).await?,
            _ = heartbeat_timer.tick() => {
                send(&mut sink, &heartbeat(jobs)).await?;
                for job_id in jobs.running_ids() {
                    send(&mut sink, &RunnerMessage::JobHeartbeat(JobHeartbeat { job_id })).await?;
                }
            }
            _ = shutdown.changed() => {
                if *shutdown.borrow() {
                    return Ok(SessionEnd::Shutdown);
                }
            }
        }
    }
}

async fn handle_center_message(
    message: CenterMessage,
    config: &ClientConfig,
    jobs: &Arc<JobManager>,
    sink: &mut Sink,
) -> Result<(), TransportError> {
    match message {
        CenterMessage::JobOffer(offer) => match jobs.accept(&offer) {
            Ok(accepted) => {
                send(
                    sink,
                    &RunnerMessage::JobAccepted(JobAccepted {
                        job_id: offer.job_id.clone(),
                    }),
                )
                .await?;
                jobs.spawn(offer, accepted);
            }
            Err(reason) => {
                tracing::info!(job = %offer.job_id, reason = %reason, "declined a job offer");
                send(
                    sink,
                    &RunnerMessage::JobDeclined(JobDeclined {
                        job_id: offer.job_id,
                        reason,
                    }),
                )
                .await?;
            }
        },
        CenterMessage::JobCancel(cancel) => {
            if !jobs.cancel(&cancel.job_id) {
                tracing::debug!(job = %cancel.job_id, "cancel for a job that is not running");
            }
        }
        CenterMessage::Ping(_) => send(sink, &heartbeat(jobs)).await?,
        CenterMessage::TokenRotate(rotate) => rotate_token(config, rotate).await,
        CenterMessage::JobAnswer(answer) => {
            if !jobs.answer(&answer.job_id, answer.answer) {
                tracing::debug!(job = %answer.job_id, "no adapter waits for this answer");
            }
        }
        CenterMessage::JobContext(context) => {
            tracing::debug!(job = %context.job_id, "job context is handled by adapters");
        }
    }
    Ok(())
}

async fn rotate_token(config: &ClientConfig, rotate: TokenRotate) {
    *config.token.lock().await = rotate.token.clone();
    if let Some(path) = &config.token_path {
        let stored = StoredToken {
            runner_id: config.runner_id.clone(),
            token: rotate.token,
        };
        if let Err(error) = token::save(path, &stored) {
            tracing::warn!(error = %error, "could not persist the rotated token");
        }
    }
}

async fn send(sink: &mut Sink, message: &RunnerMessage) -> Result<(), TransportError> {
    let body = serde_json::to_string(message)?;
    sink.send(Message::text(body)).await?;
    Ok(())
}

fn heartbeat(jobs: &JobManager) -> RunnerMessage {
    RunnerMessage::Heartbeat(Heartbeat {
        active_jobs: jobs.active_jobs(),
        last_seen_at: now_iso(),
    })
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use serde_json::{Value, json};
    use tokio::net::TcpListener;
    use tokio::sync::mpsc;
    use tokio_tungstenite::accept_async;

    use super::*;
    use crate::adapter::{AdapterFuture, AdapterHost, AdapterRegistry, AgentAdapter, AgentResult};
    use crate::adapters::host::RunnerHost;
    use crate::adapters::mock::MockAdapter;
    use crate::daemon::{McpServer, Registry};
    use crate::job::ExecutorConfig;
    use crate::protocol::JobResultStatus;

    async fn manager(adapters: Vec<Arc<dyn AgentAdapter>>) -> (tempfile::TempDir, Arc<JobManager>) {
        let dir = tempfile::tempdir().unwrap();
        crate::git::tests_support::init_repo(dir.path());
        let root = dir.path().canonicalize().unwrap();
        let registry = Registry::new();
        let host = RunnerHost::new(Arc::clone(&registry));
        let mcp = Arc::new(McpServer::bind(registry).await.unwrap());
        let config = ExecutorConfig {
            roots: vec![root.clone()],
            workspaces: BTreeMap::from([("p".to_string(), root)]),
            max_concurrent_jobs: 2,
        };
        (
            dir,
            JobManager::new(config, AdapterRegistry::new(adapters), mcp, host),
        )
    }

    fn client_config(addr: std::net::SocketAddr, workspace: &std::path::Path) -> ClientConfig {
        ClientConfig::new(
            format!("ws://{addr}"),
            "runner-token",
            vec![workspace.display().to_string()],
            vec![AdapterInfo {
                id: "mock".to_string(),
                label: "Mock".to_string(),
            }],
        )
    }

    async fn next_json(
        ws: &mut tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>,
    ) -> Option<Value> {
        while let Some(frame) = ws.next().await {
            let frame = frame.unwrap();
            if let Message::Text(text) = frame {
                return Some(serde_json::from_str(text.as_str()).unwrap());
            }
        }
        None
    }

    fn find<'a>(seen: &'a [Value], kind: &str) -> Vec<&'a Value> {
        seen.iter()
            .filter(|value| value["type"].as_str() == Some(kind))
            .collect()
    }

    #[tokio::test]
    async fn mock_control_plane_runs_a_job_from_hello_to_result() {
        let (dir, jobs) = manager(vec![Arc::new(MockAdapter::default())]).await;
        let workspace = dir.path().canonicalize().unwrap();
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut ws = accept_async(stream).await.unwrap();
            let mut seen: Vec<Value> = Vec::new();
            while let Some(value) = next_json(&mut ws).await {
                let kind = value["type"].as_str().unwrap_or_default().to_string();
                if kind == "hello" {
                    let offer = json!({
                        "type": "job.offer",
                        "jobId": "job-1",
                        "intentId": "intent-1",
                        "stage": "build",
                        "runtime": "mock",
                        "payload": {"projectKey": "p", "task": "demo", "intentShort": "demo", "prompt": "go"},
                        "leaseUntil": "2099-01-01T00:00:00.000Z"
                    });
                    ws.send(Message::text(offer.to_string())).await.unwrap();
                }
                seen.push(value);
                if kind == "job.result" {
                    break;
                }
            }
            seen
        });
        let (shutdown_tx, shutdown_rx) = watch::channel(false);
        let client = tokio::spawn(run(client_config(addr, &workspace), jobs, shutdown_rx));
        let seen = tokio::time::timeout(Duration::from_secs(20), server)
            .await
            .expect("mock center receives a job result")
            .unwrap();
        let hello = find(&seen, "hello");
        assert_eq!(hello.len(), 1);
        assert_eq!(hello[0]["protocolVersion"], 1);
        assert_eq!(hello[0]["adapters"][0]["id"], "mock");
        assert!(!find(&seen, "heartbeat").is_empty());
        assert_eq!(find(&seen, "job.accept")[0]["jobId"], "job-1");
        let statuses: Vec<&str> = find(&seen, "job.status")
            .iter()
            .filter_map(|value| value["status"].as_str())
            .collect();
        assert!(statuses.contains(&"running"));
        let diff = find(&seen, "job.diff_summary")[0];
        assert_eq!(diff["files"][0]["path"], "agent-output.txt");
        let result = find(&seen, "job.result")[0];
        assert_eq!(result["status"], "succeeded");
        assert_eq!(result["result"]["diffSummary"]["files"], 1);
        assert_eq!(result["result"]["branch"], "intentra/demo-demo");
        assert!(result["result"]["commit"].is_string());
        assert!(result["result"]["treeHash"].is_string());
        shutdown_tx.send(true).unwrap();
        tokio::time::timeout(Duration::from_secs(5), client)
            .await
            .expect("runner stops after shutdown")
            .unwrap()
            .unwrap();
    }

    #[tokio::test]
    async fn the_runner_reconnects_after_a_drop() {
        let (_dir, jobs) = manager(vec![Arc::new(MockAdapter::default())]).await;
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let addr = listener.local_addr().unwrap();
        let (hellos_tx, mut hellos_rx) = mpsc::channel(4);
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut ws = accept_async(stream).await.unwrap();
            let first = next_json(&mut ws).await.unwrap();
            hellos_tx.send(first).await.unwrap();
            drop(ws);
            let (stream, _) = listener.accept().await.unwrap();
            let mut ws = accept_async(stream).await.unwrap();
            while let Some(value) = next_json(&mut ws).await {
                if value["type"] == "hello" {
                    hellos_tx.send(value).await.unwrap();
                    break;
                }
            }
            tokio::time::sleep(Duration::from_secs(10)).await;
        });
        let (shutdown_tx, shutdown_rx) = watch::channel(false);
        let client = tokio::spawn(run(
            ClientConfig::new(format!("ws://{addr}"), "token", vec![], vec![]),
            jobs,
            shutdown_rx,
        ));
        let first = tokio::time::timeout(Duration::from_secs(5), hellos_rx.recv())
            .await
            .expect("first hello arrives")
            .unwrap();
        assert_eq!(first["type"], "hello");
        let second = tokio::time::timeout(Duration::from_secs(5), hellos_rx.recv())
            .await
            .expect("the runner reconnects within five seconds")
            .unwrap();
        assert_eq!(second["type"], "hello");
        assert_eq!(second["protocolVersion"], first["protocolVersion"]);
        shutdown_tx.send(true).unwrap();
        server.abort();
        tokio::time::timeout(Duration::from_secs(5), client)
            .await
            .expect("runner stops after shutdown")
            .unwrap()
            .unwrap();
    }

    struct SlowAdapter;

    impl AgentAdapter for SlowAdapter {
        fn info(&self) -> AdapterInfo {
            AdapterInfo {
                id: "slow".to_string(),
                label: "Slow".to_string(),
            }
        }

        fn capabilities(&self) -> crate::adapter::AdapterCapabilities {
            crate::adapter::AdapterCapabilities::default()
        }

        fn detect<'a>(&'a self) -> AdapterFuture<'a, crate::adapter::DetectResult> {
            Box::pin(async { crate::adapter::DetectResult::available("test") })
        }

        fn run<'a>(
            &'a self,
            _spec: crate::adapter::JobSpec,
        ) -> AdapterFuture<'a, Result<AgentResult, crate::adapter::AdapterError>> {
            Box::pin(async move {
                tokio::time::sleep(Duration::from_secs(60)).await;
                Ok(AgentResult {
                    status: JobResultStatus::Succeeded,
                    summary: None,
                    findings: None,
                    verdict: None,
                    usage: Default::default(),
                    links: vec![],
                })
            })
        }

        fn cancel<'a>(&'a self, _job_id: &'a str) -> AdapterFuture<'a, ()> {
            Box::pin(async {})
        }
    }

    #[tokio::test]
    async fn a_job_cancel_stops_the_job_and_reports_cancelled() {
        let (_dir, jobs) = manager(vec![Arc::new(SlowAdapter)]).await;
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut ws = accept_async(stream).await.unwrap();
            let mut seen: Vec<Value> = Vec::new();
            while let Some(value) = next_json(&mut ws).await {
                let kind = value["type"].as_str().unwrap_or_default().to_string();
                if kind == "hello" {
                    let offer = json!({
                        "type": "job.offer",
                        "jobId": "job-2",
                        "intentId": "intent-1",
                        "stage": "build",
                        "runtime": "slow",
                        "payload": {"projectKey": "p", "task": "demo"},
                        "leaseUntil": "2099-01-01T00:00:00.000Z"
                    });
                    ws.send(Message::text(offer.to_string())).await.unwrap();
                }
                if kind == "job.accept" {
                    let cancel = json!({"type": "job.cancel", "jobId": "job-2", "reason": "test"});
                    ws.send(Message::text(cancel.to_string())).await.unwrap();
                }
                seen.push(value);
                if kind == "job.result" {
                    break;
                }
            }
            seen
        });
        let (shutdown_tx, shutdown_rx) = watch::channel(false);
        let client = tokio::spawn(run(
            ClientConfig::new(format!("ws://{addr}"), "token", vec![], vec![]),
            jobs,
            shutdown_rx,
        ));
        let seen = tokio::time::timeout(Duration::from_secs(20), server)
            .await
            .expect("a cancelled job reports a result")
            .unwrap();
        let result = find(&seen, "job.result")[0];
        assert_eq!(result["status"], "cancelled");
        shutdown_tx.send(true).unwrap();
        tokio::time::timeout(Duration::from_secs(5), client)
            .await
            .expect("runner stops after shutdown")
            .unwrap()
            .unwrap();
    }

    struct AskingAdapter {
        host: Arc<RunnerHost>,
    }

    impl AgentAdapter for AskingAdapter {
        fn info(&self) -> AdapterInfo {
            AdapterInfo {
                id: "ask".to_string(),
                label: "Ask".to_string(),
            }
        }

        fn capabilities(&self) -> crate::adapter::AdapterCapabilities {
            crate::adapter::AdapterCapabilities::default()
        }

        fn detect<'a>(&'a self) -> AdapterFuture<'a, crate::adapter::DetectResult> {
            Box::pin(async { crate::adapter::DetectResult::available("test") })
        }

        fn run<'a>(
            &'a self,
            spec: crate::adapter::JobSpec,
        ) -> AdapterFuture<'a, Result<AgentResult, crate::adapter::AdapterError>> {
            Box::pin(async move {
                let answer = self
                    .host
                    .ask(
                        &spec.id,
                        json!({
                            "stage": "build",
                            "question": "Which?",
                            "context": "Both fit",
                            "trigger": "E2",
                            "options": [{"id": "a", "label": "A"}, {"id": "b", "label": "B"}],
                            "defaultOption": "a"
                        }),
                    )
                    .await;
                Ok(AgentResult {
                    status: JobResultStatus::Succeeded,
                    summary: answer.map(|answer| answer.to_string()),
                    findings: None,
                    verdict: None,
                    usage: Default::default(),
                    links: vec![],
                })
            })
        }

        fn cancel<'a>(&'a self, _job_id: &'a str) -> AdapterFuture<'a, ()> {
            Box::pin(async {})
        }
    }

    #[tokio::test]
    async fn a_job_question_crosses_the_center_and_its_answer_reaches_the_adapter() {
        let dir = tempfile::tempdir().unwrap();
        crate::git::tests_support::init_repo(dir.path());
        let workspace = dir.path().canonicalize().unwrap();
        let registry = Registry::new();
        let host = RunnerHost::new(Arc::clone(&registry));
        let mcp = Arc::new(McpServer::bind(Arc::clone(&registry)).await.unwrap());
        let config = ExecutorConfig {
            roots: vec![workspace.clone()],
            workspaces: BTreeMap::from([("p".to_string(), workspace.clone())]),
            max_concurrent_jobs: 2,
        };
        let jobs = JobManager::new(
            config,
            AdapterRegistry::new(vec![Arc::new(AskingAdapter {
                host: Arc::clone(&host),
            })]),
            mcp,
            host,
        );
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut ws = accept_async(stream).await.unwrap();
            let mut seen: Vec<Value> = Vec::new();
            while let Some(value) = next_json(&mut ws).await {
                let kind = value["type"].as_str().unwrap_or_default().to_string();
                if kind == "hello" {
                    let offer = json!({
                        "type": "job.offer",
                        "jobId": "job-1",
                        "intentId": "intent-1",
                        "stage": "build",
                        "runtime": "ask",
                        "payload": {"projectKey": "p", "task": "demo"},
                        "leaseUntil": "2099-01-01T00:00:00.000Z"
                    });
                    ws.send(Message::text(offer.to_string())).await.unwrap();
                }
                if kind == "job.question" {
                    let answer = json!({
                        "type": "job.answer",
                        "jobId": "job-1",
                        "answer": {"answers": [{"id": "q1", "selected": ["a"]}]}
                    });
                    ws.send(Message::text(answer.to_string())).await.unwrap();
                }
                seen.push(value);
                if kind == "job.result" {
                    break;
                }
            }
            seen
        });
        let (shutdown_tx, shutdown_rx) = watch::channel(false);
        let client = tokio::spawn(run(
            ClientConfig::new(format!("ws://{addr}"), "token", vec![], vec![]),
            jobs,
            shutdown_rx,
        ));
        let seen = tokio::time::timeout(Duration::from_secs(20), server)
            .await
            .expect("the center receives the question and the result")
            .unwrap();
        assert_eq!(
            find(&seen, "job.question")[0]["question"]["question"],
            "Which?"
        );
        let result = find(&seen, "job.result")[0];
        let summary = result["result"]["summary"].as_str().unwrap();
        assert!(summary.contains("selected"), "{summary}");
        shutdown_tx.send(true).unwrap();
        tokio::time::timeout(Duration::from_secs(5), client)
            .await
            .expect("runner stops after shutdown")
            .unwrap()
            .unwrap();
    }
}
