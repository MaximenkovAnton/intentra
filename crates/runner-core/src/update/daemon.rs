use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::{Notify, watch};

use crate::config::UpdateConfig;
use crate::job::JobManager;
use crate::update::apply::{
    ApplyOutcome, ApplyRequest, Installer, Restarter, apply_release, report_outcome,
};
use crate::update::client::{UpdateClient, UpdateReport, UpdateStatus};
use crate::update::state::{PendingUpdate, UpdateState};
use crate::update::{public_key, sanitize_for_log};

fn random_sample() -> f64 {
    let mut bytes = [0u8; 8];
    getrandom::fill(&mut bytes).expect("operating system randomness");
    u64::from_le_bytes(bytes) as f64 / u64::MAX as f64
}

pub fn jittered_interval(base: Duration, sample: f64) -> Duration {
    let factor = 0.9 + 0.2 * sample.clamp(0.0, 1.0);
    let millis = base.as_millis() as f64 * factor;
    Duration::from_millis(millis.round() as u64)
}

pub struct UpdateDaemon {
    pub client: UpdateClient,
    pub update: UpdateConfig,
    pub current_version: String,
    pub state_dir: PathBuf,
    pub jobs: Arc<JobManager>,
    pub installer: Arc<dyn Installer>,
    pub restarter: Arc<dyn Restarter>,
    pub waiting_for_hello: Option<Arc<Notify>>,
}

impl UpdateDaemon {
    fn interval(&self) -> Duration {
        jittered_interval(
            Duration::from_secs(self.update.check_interval_min.saturating_mul(60)),
            random_sample(),
        )
    }
}

fn pending_for_current(daemon: &UpdateDaemon) -> Option<PendingUpdate> {
    match UpdateState::load(&daemon.state_dir) {
        Ok(Some(state)) => state.pending_for(&daemon.current_version).cloned(),
        Ok(None) => None,
        Err(error) => {
            tracing::warn!(error = %error, "ignoring an unreadable update state file");
            None
        }
    }
}

pub async fn check_once(daemon: &UpdateDaemon) -> Option<ApplyOutcome> {
    if !daemon.jobs.begin_update() {
        tracing::info!("deferring the update check while a job is active");
        return None;
    }
    let outcome = match daemon
        .client
        .update(&daemon.current_version, daemon.update.channel)
        .await
    {
        Ok(update) if update.available => {
            if let Some(reason) = update.apply_blocker() {
                tracing::info!(reason = %reason, "not applying an available update");
                None
            } else {
                let request = ApplyRequest {
                    client: &daemon.client,
                    update: &daemon.update,
                    current_version: &daemon.current_version,
                    state_dir: &daemon.state_dir,
                    installer: daemon.installer.as_ref(),
                    restarter: Some(daemon.restarter.as_ref()),
                };
                let outcome = apply_release(&request, &update).await;
                match &outcome {
                    ApplyOutcome::Applied { version } => tracing::info!(
                        from = %daemon.current_version,
                        to = %version,
                        channel = %daemon.update.channel.as_str(),
                        "installed an update"
                    ),
                    ApplyOutcome::Failed(report) => tracing::warn!(
                        from = %report.from_version,
                        to = %report.to_version,
                        channel = %daemon.update.channel.as_str(),
                        reason = %sanitize_for_log(report.reason.as_deref().unwrap_or_default()),
                        "the update failed"
                    ),
                    ApplyOutcome::RolledBack(report) => tracing::warn!(
                        from = %report.from_version,
                        to = %report.to_version,
                        channel = %daemon.update.channel.as_str(),
                        reason = %sanitize_for_log(report.reason.as_deref().unwrap_or_default()),
                        "the update rolled back"
                    ),
                }
                Some(outcome)
            }
        }
        Ok(_) => {
            tracing::info!(current = %daemon.current_version, "the runner is up to date");
            None
        }
        Err(error) => {
            tracing::warn!(error = %error, "the update check failed; retrying on the next cycle");
            None
        }
    };
    daemon.jobs.end_update();
    report_outcome(
        Some(&daemon.client),
        outcome.as_ref().and_then(ApplyOutcome::report),
    )
    .await;
    if let Some(ApplyOutcome::RolledBack(_)) = &outcome
        && let Err(error) = daemon.restarter.restart()
    {
        tracing::error!(error = %error, "cannot restart the previous runner");
    }
    outcome
}

pub async fn confirm_pending(daemon: &UpdateDaemon) -> Option<UpdateReport> {
    let mut state = match UpdateState::load(&daemon.state_dir) {
        Ok(Some(state)) => state,
        Ok(None) => return None,
        Err(error) => {
            tracing::warn!(error = %error, "ignoring an unreadable update state file");
            return None;
        }
    };
    let pending = state.pending_for(&daemon.current_version)?.clone();
    let report = UpdateReport::new(
        pending.from,
        pending.to.clone(),
        UpdateStatus::Applied,
        None,
    );
    state.confirm(&daemon.current_version);
    if let Err(error) = state.save(&daemon.state_dir) {
        tracing::warn!(error = %error, "cannot persist the confirmed update");
    }
    match daemon.client.report(&report).await {
        Ok(()) => tracing::info!(
            from = %report.from_version,
            to = %report.to_version,
            "confirmed the applied update"
        ),
        Err(error) => tracing::warn!(
            error = %error,
            "could not report the applied update; keeping it confirmed"
        ),
    }
    Some(report)
}

async fn wait_for_hello(
    hello: &mut watch::Receiver<bool>,
    shutdown: &mut watch::Receiver<bool>,
) -> bool {
    if *hello.borrow() {
        return true;
    }
    loop {
        tokio::select! {
            changed = hello.changed() => {
                if *hello.borrow() {
                    return true;
                }
                if changed.is_err() {
                    return false;
                }
            }
            _ = shutdown.changed() => {
                if *shutdown.borrow() {
                    return false;
                }
            }
        }
    }
}

pub async fn run(
    daemon: Arc<UpdateDaemon>,
    mut hello: watch::Receiver<bool>,
    mut shutdown: watch::Receiver<bool>,
) {
    let automatic = daemon.update.enabled && public_key().is_ok();
    if !automatic {
        tracing::info!(
            enabled = daemon.update.enabled,
            "automatic update checks are off"
        );
    }
    if !automatic && pending_for_current(&daemon).is_none() {
        return;
    }
    if let Some(signal) = &daemon.waiting_for_hello {
        signal.notify_one();
    }
    if !wait_for_hello(&mut hello, &mut shutdown).await {
        return;
    }
    confirm_pending(&daemon).await;
    if !automatic {
        return;
    }
    loop {
        check_once(&daemon).await;
        tokio::select! {
            _ = tokio::time::sleep(daemon.interval()) => {}
            _ = shutdown.changed() => {
                if *shutdown.borrow() {
                    return;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::await_holding_lock)]

    use std::collections::BTreeMap;
    use std::path::{Path, PathBuf};
    use std::sync::{Arc, Mutex};

    use serde_json::{Value, json};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::{TcpListener, TcpStream};
    use tokio::sync::Notify;
    use tokio::sync::watch;

    use super::*;
    use crate::adapter::AdapterRegistry;
    use crate::adapters::host::RunnerHost;
    use crate::adapters::mock::MockAdapter;
    use crate::config::{Channel, UpdateConfig};
    use crate::daemon::{McpServer, Registry};
    use crate::job::ExecutorConfig;
    use crate::protocol::JobOffer;
    use crate::update::apply::RUNNER_BINARY;
    use crate::update::apply::test_support::{
        FakeInstaller, FakeRestarter, ReleaseSpec, archive, signed_update,
    };
    use crate::update::apply::{ReconcileRequest, reconcile_pending};
    use crate::update::fixtures;

    const BINARY_BYTES: &[u8] = b"#!/bin/sh\necho 0.2.0\n";
    const WRONG_SHA: &str = "0000000000000000000000000000000000000000000000000000000000000000";

    fn enabled() -> UpdateConfig {
        UpdateConfig {
            enabled: true,
            channel: Channel::Stable,
            check_interval_min: 5,
            allow_insecure_http: true,
        }
    }

    fn disabled() -> UpdateConfig {
        UpdateConfig {
            enabled: false,
            ..enabled()
        }
    }

    fn release_archive() -> Vec<u8> {
        archive(&[
            ("LICENSE", b"MIT\n".as_slice()),
            (RUNNER_BINARY, BINARY_BYTES),
        ])
    }

    fn unavailable_update() -> Value {
        json!({
            "available": false,
            "channel": "stable",
            "latestVersion": null,
            "pinnedVersion": null,
            "autoUpdate": true,
        })
    }

    #[derive(Debug, Clone)]
    struct Recorded {
        method: String,
        path: String,
        body: String,
    }

    struct StubCenter {
        addr: std::net::SocketAddr,
        requests: Arc<Mutex<Vec<Recorded>>>,
        notify: Arc<Notify>,
    }

    impl StubCenter {
        fn url(&self) -> String {
            format!("ws://{}", self.addr)
        }

        fn requests(&self) -> Vec<Recorded> {
            self.requests.lock().unwrap().clone()
        }

        fn update_requests(&self) -> usize {
            self.requests()
                .iter()
                .filter(|request| request.path.starts_with("/api/runners/update?"))
                .count()
        }

        fn artifact_requests(&self) -> usize {
            self.requests()
                .iter()
                .filter(|request| request.path.starts_with("/api/runners/update/artifact/"))
                .count()
        }

        fn reports(&self) -> Vec<Value> {
            self.requests()
                .iter()
                .filter(|request| {
                    request.method == "POST"
                        && request.path.starts_with("/api/runners/update/report")
                })
                .map(|request| serde_json::from_str(&request.body).unwrap())
                .collect()
        }

        async fn wait_for(&self, count: usize) {
            self.wait_for_until(count, Duration::from_secs(5))
                .await
                .unwrap();
        }

        async fn wait_for_until(&self, count: usize, timeout: Duration) -> Result<(), String> {
            tokio::time::timeout(timeout, async {
                loop {
                    if self.requests.lock().unwrap().len() >= count {
                        return;
                    }
                    self.notify.notified().await;
                }
            })
            .await
            .map_err(|_| {
                format!(
                    "timed out after {timeout:?} waiting for a request: {} of {count}",
                    self.requests().len()
                )
            })
        }
    }

    async fn stub_center(update: Value, artifact: Vec<u8>, report_status: u16) -> StubCenter {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let addr = listener.local_addr().unwrap();
        let requests = Arc::new(Mutex::new(Vec::new()));
        let notify = Arc::new(Notify::new());
        let recorded = Arc::clone(&requests);
        let signal = Arc::clone(&notify);
        let update_body = serde_json::to_vec(&update).unwrap();
        tokio::spawn(async move {
            loop {
                let Ok((mut stream, _)) = listener.accept().await else {
                    return;
                };
                let Some(request) = read_http_request(&mut stream).await else {
                    continue;
                };
                recorded.lock().unwrap().push(request.clone());
                signal.notify_one();
                let (status, content_type, body) =
                    if request.path.starts_with("/api/runners/update/artifact/") {
                        (200, "application/octet-stream", artifact.clone())
                    } else if request.path.starts_with("/api/runners/update/report") {
                        if report_status == 204 {
                            (204, "application/json", Vec::new())
                        } else {
                            (
                                report_status,
                                "application/json",
                                br#"{"error":"report rejected"}"#.to_vec(),
                            )
                        }
                    } else {
                        (200, "application/json", update_body.clone())
                    };
                let reason = if status == 204 { "No Content" } else { "OK" };
                let head = format!(
                    "HTTP/1.1 {status} {reason}\r\ncontent-type: {content_type}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                    body.len()
                );
                let _ = stream.write_all(head.as_bytes()).await;
                let _ = stream.write_all(&body).await;
                let _ = stream.shutdown().await;
            }
        });
        StubCenter {
            addr,
            requests,
            notify,
        }
    }

    fn header_end(buffer: &[u8]) -> Option<usize> {
        buffer
            .windows(4)
            .position(|w| w == b"\r\n\r\n")
            .map(|i| i + 4)
    }

    async fn read_http_request(stream: &mut TcpStream) -> Option<Recorded> {
        let mut buffer = Vec::new();
        let mut chunk = [0u8; 4096];
        let end = loop {
            let read = stream.read(&mut chunk).await.ok()?;
            if read == 0 {
                return None;
            }
            buffer.extend_from_slice(&chunk[..read]);
            if let Some(end) = header_end(&buffer) {
                break end;
            }
        };
        let header = String::from_utf8_lossy(&buffer[..end]).to_string();
        let mut lines = header.split("\r\n");
        let request_line = lines.next()?;
        let mut parts = request_line.split_whitespace();
        let method = parts.next()?.to_string();
        let path = parts.next()?.to_string();
        let content_length = lines
            .filter_map(|line| {
                let (name, value) = line.split_once(':')?;
                if name.eq_ignore_ascii_case("content-length") {
                    value.trim().parse::<usize>().ok()
                } else {
                    None
                }
            })
            .next()
            .unwrap_or(0);
        while buffer.len() < end + content_length {
            let read = stream.read(&mut chunk).await.ok()?;
            if read == 0 {
                break;
            }
            buffer.extend_from_slice(&chunk[..read]);
        }
        let body = String::from_utf8_lossy(&buffer[end..(end + content_length).min(buffer.len())])
            .to_string();
        Some(Recorded { method, path, body })
    }

    struct Harness {
        _root: tempfile::TempDir,
        _repo: tempfile::TempDir,
        daemon: Arc<UpdateDaemon>,
        installer: Arc<FakeInstaller>,
        restarter: Arc<FakeRestarter>,
        state_dir: PathBuf,
        jobs: Arc<JobManager>,
    }

    async fn setup(stub: &StubCenter, update: UpdateConfig) -> Harness {
        setup_with_signal(stub, update, None).await
    }

    async fn setup_with_signal(
        stub: &StubCenter,
        update: UpdateConfig,
        waiting_for_hello: Option<Arc<Notify>>,
    ) -> Harness {
        let root = tempfile::tempdir().unwrap();
        let state_dir = root.path().join(".intentra");
        std::fs::create_dir_all(&state_dir).unwrap();
        let repo = tempfile::tempdir().unwrap();
        crate::git::tests_support::init_repo(repo.path());
        let workspace = repo.path().canonicalize().unwrap();
        let registry = Registry::new();
        let host = RunnerHost::new(Arc::clone(&registry));
        let mcp = Arc::new(McpServer::bind(registry).await.unwrap());
        let jobs = JobManager::new(
            ExecutorConfig {
                roots: vec![workspace.clone()],
                workspaces: BTreeMap::from([("p".to_string(), workspace)]),
                max_concurrent_jobs: 1,
            },
            AdapterRegistry::new(vec![Arc::new(MockAdapter::default())]),
            mcp,
            host,
        );
        let installer = Arc::new(FakeInstaller::default());
        let restarter = Arc::new(FakeRestarter::default());
        let client = UpdateClient::new(&stub.url(), "runner-secret", true).unwrap();
        let daemon = Arc::new(UpdateDaemon {
            client,
            update,
            current_version: env!("CARGO_PKG_VERSION").to_string(),
            state_dir: state_dir.clone(),
            jobs: Arc::clone(&jobs),
            installer: installer.clone(),
            restarter: restarter.clone(),
            waiting_for_hello,
        });
        Harness {
            _root: root,
            _repo: repo,
            daemon,
            installer,
            restarter,
            state_dir,
            jobs,
        }
    }

    fn write_pending(state_dir: &Path, from: &str, to: &str, attempts: u32) {
        let state = UpdateState {
            pending: Some(PendingUpdate {
                from: from.to_string(),
                to: to.to_string(),
                attempts,
                staged_at: "2026-11-27T18:00:00.000Z".to_string(),
            }),
            confirmed: None,
        };
        state.save(state_dir).unwrap();
    }

    fn offer() -> JobOffer {
        JobOffer {
            job_id: "job-1".to_string(),
            intent_id: "intent-1".to_string(),
            stage: "build".to_string(),
            runtime: "mock".to_string(),
            payload: json!({"projectKey": "p"}),
            lease_until: "2099-01-01T00:00:00.000Z".to_string(),
        }
    }

    #[test]
    fn jitter_stays_within_ten_percent() {
        let base = Duration::from_secs(360 * 60);
        assert_eq!(jittered_interval(base, 0.0), Duration::from_secs(19440));
        assert_eq!(jittered_interval(base, 0.5), Duration::from_secs(21600));
        assert_eq!(jittered_interval(base, 1.0), Duration::from_secs(23760));
    }

    #[tokio::test]
    async fn applies_a_release_when_idle() {
        let _lock = fixtures::lock_env();
        let _env = fixtures::TestPubkeyEnv::set();
        let archive = release_archive();
        let spec = ReleaseSpec::for_archive("0.2.0", &archive);
        let stub = stub_center(signed_update(&spec, &archive), archive, 204).await;
        let harness = setup(&stub, enabled()).await;
        let state_dir = harness.state_dir.clone();
        let installer = Arc::clone(&harness.installer);
        harness.installer.probe(Box::new(move || {
            assert_eq!(
                installer.backups(),
                1,
                "the previous binary must be backed up before install"
            );
            let state = UpdateState::load(&state_dir)
                .unwrap()
                .expect("the update state file must exist before the binary is installed");
            assert_eq!(
                state.pending.as_ref().map(|pending| pending.to.as_str()),
                Some("0.2.0"),
                "the pending update must be persisted before the binary is installed"
            );
        }));
        let (_hello_tx, hello_rx) = watch::channel(true);
        let (shutdown_tx, shutdown_rx) = watch::channel(false);
        let run = tokio::spawn(run(Arc::clone(&harness.daemon), hello_rx, shutdown_rx));
        stub.wait_for(2).await;
        shutdown_tx.send(true).unwrap();
        tokio::time::timeout(Duration::from_secs(5), run)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(harness.installer.calls(), 1);
        assert_eq!(harness.installer.backups(), 1);
        assert_eq!(harness.restarter.calls(), 1);
        assert_eq!(stub.artifact_requests(), 1);
        let state = UpdateState::load(&harness.state_dir).unwrap().unwrap();
        assert_eq!(state.attempts(), 0);
        assert_eq!(
            state.pending.as_ref().map(|pending| pending.from.as_str()),
            Some(env!("CARGO_PKG_VERSION"))
        );
        assert_eq!(
            state.pending.as_ref().map(|pending| pending.to.as_str()),
            Some("0.2.0")
        );
    }

    #[tokio::test]
    async fn restart_failure_rolls_back_and_reports_before_the_recovery_restart() {
        let _lock = fixtures::lock_env();
        let _env = fixtures::TestPubkeyEnv::set();
        let archive = release_archive();
        let spec = ReleaseSpec::for_archive("0.2.0", &archive);
        let stub = stub_center(signed_update(&spec, &archive), archive, 204).await;
        let harness = setup(&stub, enabled()).await;
        harness.restarter.fail_first();
        let state_dir = harness.state_dir.clone();
        let requests = Arc::clone(&stub.requests);
        harness.restarter.probe(Box::new(move || {
            let state = UpdateState::load(&state_dir).unwrap().unwrap();
            assert_eq!(
                state.pending, None,
                "the rollback must persist the cleared state before the recovery restart"
            );
            let reported = requests.lock().unwrap().iter().any(|request| {
                request.method == "POST"
                    && request.path.starts_with("/api/runners/update/report")
                    && request.body.contains("\"rolled_back\"")
            });
            assert!(
                reported,
                "the rolled_back report must reach the center before the recovery restart"
            );
        }));
        let outcome = check_once(&harness.daemon).await.unwrap();
        assert!(matches!(outcome, ApplyOutcome::RolledBack(_)));
        assert_eq!(harness.installer.calls(), 2);
        assert_eq!(harness.restarter.calls(), 2);
        let reports = stub.reports();
        assert_eq!(reports.len(), 1);
        assert_eq!(reports[0]["status"], "rolled_back");
        let state = UpdateState::load(&harness.state_dir).unwrap().unwrap();
        assert_eq!(state.pending, None);
    }

    #[tokio::test]
    async fn startup_rollback_reports_before_the_restart() {
        for attempts in [0, 1] {
            let stub = stub_center(unavailable_update(), Vec::new(), 204).await;
            let dir = tempfile::tempdir().unwrap();
            write_pending(dir.path(), "0.1.0", env!("CARGO_PKG_VERSION"), attempts);
            let installer = FakeInstaller::default();
            let restarter = FakeRestarter::default();
            let client = UpdateClient::new(&stub.url(), "runner-secret", true).unwrap();
            let requests = Arc::clone(&stub.requests);
            let state_dir = dir.path().to_path_buf();
            restarter.probe(Box::new(move || {
                let state = UpdateState::load(&state_dir).unwrap().unwrap();
                assert_eq!(
                    state.pending, None,
                    "attempts={attempts}: the rollback must persist the cleared state before the restart"
                );
                let reported = requests.lock().unwrap().iter().any(|request| {
                    request.method == "POST"
                        && request.path.starts_with("/api/runners/update/report")
                        && request.body.contains("\"rolled_back\"")
                });
                assert!(
                    reported,
                    "attempts={attempts}: the rolled_back report must reach the center before the restart"
                );
            }));
            let config = dir.path().join("missing-config.toml");
            let token = dir.path().join("missing-token");
            let report = reconcile_pending(&ReconcileRequest {
                state_dir: dir.path(),
                current_version: env!("CARGO_PKG_VERSION"),
                config_path: &config,
                token_path: &token,
                installer: &installer,
                restarter: &restarter,
                client: Some(&client),
            })
            .await
            .expect("an unconfirmed update reports a rollback");
            assert_eq!(
                report.status,
                UpdateStatus::RolledBack,
                "attempts={attempts}"
            );
            assert_eq!(installer.calls(), 1, "attempts={attempts}");
            assert_eq!(restarter.calls(), 1, "attempts={attempts}");
            let reports = stub.reports();
            assert_eq!(reports.len(), 1, "attempts={attempts}");
            assert_eq!(reports[0]["status"], "rolled_back", "attempts={attempts}");
            let state = UpdateState::load(dir.path()).unwrap().unwrap();
            assert_eq!(state.pending, None, "attempts={attempts}");
        }
    }

    #[tokio::test]
    async fn defers_while_a_job_is_active() {
        let _lock = fixtures::lock_env();
        let _env = fixtures::TestPubkeyEnv::set();
        let archive = release_archive();
        let spec = ReleaseSpec::for_archive("0.2.0", &archive);
        let stub = stub_center(signed_update(&spec, &archive), archive, 204).await;
        let harness = setup(&stub, enabled()).await;
        let _accepted = harness.jobs.accept(&offer()).unwrap();
        let deferred = check_once(&harness.daemon).await;
        assert_eq!(deferred, None);
        assert_eq!(stub.artifact_requests(), 0);
        assert_eq!(harness.installer.calls(), 0);
        harness.jobs.release("job-1");
        let applied = check_once(&harness.daemon).await;
        assert!(matches!(applied, Some(ApplyOutcome::Applied { .. })));
        assert_eq!(stub.artifact_requests(), 1);
        assert_eq!(harness.installer.calls(), 1);
    }

    #[tokio::test]
    async fn refuses_a_manifest_that_disagrees_with_the_response() {
        let _lock = fixtures::lock_env();
        let _env = fixtures::TestPubkeyEnv::set();
        let archive = release_archive();
        let mut channel_mismatch = ReleaseSpec::for_archive("0.2.0", &archive);
        channel_mismatch.channel = "beta".to_string();
        let mut protocol_mismatch = ReleaseSpec::for_archive("0.2.0", &archive);
        protocol_mismatch.protocol = 2;
        let mut latest_mismatch = ReleaseSpec::for_archive("0.2.0", &archive);
        latest_mismatch.latest = "0.2.1".to_string();
        for (name, spec) in [
            ("channel mismatch", channel_mismatch),
            ("protocol mismatch", protocol_mismatch),
            ("latestVersion mismatch", latest_mismatch),
        ] {
            let stub = stub_center(signed_update(&spec, &archive), archive.clone(), 204).await;
            let harness = setup(&stub, enabled()).await;
            let outcome = check_once(&harness.daemon).await.unwrap();
            let report = outcome.report().expect("a rejection reports a failure");
            assert_eq!(report.status, UpdateStatus::Failed, "{name}");
            assert_eq!(harness.installer.calls(), 0, "{name}");
            assert_eq!(harness.installer.backups(), 0, "{name}");
            let reports = stub.reports();
            assert_eq!(reports.len(), 1, "{name}");
            assert_eq!(reports[0]["status"], "failed", "{name}");
        }
    }

    #[tokio::test]
    async fn sha256_mismatch_is_not_applied() {
        let _lock = fixtures::lock_env();
        let _env = fixtures::TestPubkeyEnv::set();
        let archive = release_archive();
        let mut spec = ReleaseSpec::for_archive("0.2.0", &archive);
        spec.sha256 = WRONG_SHA.to_string();
        let stub = stub_center(signed_update(&spec, &archive), archive, 204).await;
        let harness = setup(&stub, enabled()).await;
        let outcome = check_once(&harness.daemon).await.unwrap();
        let report = outcome
            .report()
            .expect("a digest mismatch reports a failure");
        assert_eq!(report.status, UpdateStatus::Failed);
        assert_eq!(harness.installer.calls(), 0);
        assert!(
            !harness
                .state_dir
                .join(crate::update::apply::ARCHIVE_STAGING)
                .exists()
        );
        let reports = stub.reports();
        assert_eq!(reports[0]["status"], "failed");
    }

    #[tokio::test]
    async fn tampered_signature_is_not_applied() {
        let _lock = fixtures::lock_env();
        let _env = fixtures::TestPubkeyEnv::set();
        let archive = release_archive();
        let spec = ReleaseSpec::for_archive("0.2.0", &archive);
        let mut update = signed_update(&spec, &archive);
        let signature = update["signature"].as_str().unwrap().to_string();
        let first = if signature.starts_with('A') { 'B' } else { 'A' };
        update["signature"] = json!(format!("{first}{}", &signature[1..]));
        let stub = stub_center(update, archive, 204).await;
        let harness = setup(&stub, enabled()).await;
        let outcome = check_once(&harness.daemon).await.unwrap();
        let report = outcome
            .report()
            .expect("a tampered signature reports a failure");
        assert_eq!(report.status, UpdateStatus::Failed);
        assert_eq!(harness.installer.calls(), 0);
        assert_eq!(harness.installer.backups(), 0);
        let reports = stub.reports();
        assert_eq!(reports[0]["status"], "failed");
    }

    #[tokio::test]
    async fn hello_confirms_and_reports_applied() {
        let archive = release_archive();
        let spec = ReleaseSpec::for_archive("0.2.0", &archive);
        let stub = stub_center(signed_update(&spec, &archive), archive, 204).await;
        let harness = setup(&stub, disabled()).await;
        write_pending(&harness.state_dir, "0.1.0", env!("CARGO_PKG_VERSION"), 0);
        let (_hello_tx, hello_rx) = watch::channel(true);
        let (_shutdown_tx, shutdown_rx) = watch::channel(false);
        tokio::time::timeout(
            Duration::from_secs(5),
            run(Arc::clone(&harness.daemon), hello_rx, shutdown_rx),
        )
        .await
        .unwrap();
        let reports = stub.reports();
        assert_eq!(reports.len(), 1);
        assert_eq!(reports[0]["status"], "applied");
        assert_eq!(reports[0]["fromVersion"], "0.1.0");
        assert_eq!(reports[0]["toVersion"], env!("CARGO_PKG_VERSION"));
        let state = UpdateState::load(&harness.state_dir).unwrap().unwrap();
        assert_eq!(
            state
                .confirmed
                .as_ref()
                .map(|confirmed| confirmed.version.as_str()),
            Some(env!("CARGO_PKG_VERSION"))
        );
        assert_eq!(state.pending, None);
    }

    #[tokio::test]
    async fn report_failure_keeps_the_update_confirmed() {
        let archive = release_archive();
        let spec = ReleaseSpec::for_archive("0.2.0", &archive);
        let stub = stub_center(signed_update(&spec, &archive), archive, 500).await;
        let harness = setup(&stub, disabled()).await;
        write_pending(&harness.state_dir, "0.1.0", env!("CARGO_PKG_VERSION"), 0);
        let (_hello_tx, hello_rx) = watch::channel(true);
        let (_shutdown_tx, shutdown_rx) = watch::channel(false);
        tokio::time::timeout(
            Duration::from_secs(5),
            run(Arc::clone(&harness.daemon), hello_rx, shutdown_rx),
        )
        .await
        .unwrap();
        assert_eq!(stub.reports().len(), 1);
        let state = UpdateState::load(&harness.state_dir).unwrap().unwrap();
        assert_eq!(
            state
                .confirmed
                .as_ref()
                .map(|confirmed| confirmed.version.as_str()),
            Some(env!("CARGO_PKG_VERSION"))
        );
        assert_eq!(state.pending, None);
        assert_eq!(harness.installer.calls(), 0);
    }

    #[tokio::test]
    async fn pending_confirmation_runs_when_checks_are_disabled() {
        let archive = release_archive();
        let spec = ReleaseSpec::for_archive("0.2.0", &archive);
        let stub = stub_center(signed_update(&spec, &archive), archive, 204).await;
        let harness = setup(&stub, disabled()).await;
        write_pending(&harness.state_dir, "0.1.0", env!("CARGO_PKG_VERSION"), 0);
        let (_hello_tx, hello_rx) = watch::channel(true);
        let (_shutdown_tx, shutdown_rx) = watch::channel(false);
        tokio::time::timeout(
            Duration::from_secs(5),
            run(Arc::clone(&harness.daemon), hello_rx, shutdown_rx),
        )
        .await
        .unwrap();
        assert_eq!(stub.update_requests(), 0);
        assert_eq!(stub.reports()[0]["status"], "applied");
        let state = UpdateState::load(&harness.state_dir).unwrap().unwrap();
        assert!(state.confirmed.is_some());
    }

    #[tokio::test]
    async fn disabled_or_unkeyed_runner_does_not_check() {
        let stub = stub_center(unavailable_update(), Vec::new(), 204).await;
        let harness = setup(&stub, disabled()).await;
        let (_hello_tx, hello_rx) = watch::channel(false);
        let (_shutdown_tx, shutdown_rx) = watch::channel(false);
        tokio::time::timeout(
            Duration::from_secs(5),
            run(Arc::clone(&harness.daemon), hello_rx, shutdown_rx),
        )
        .await
        .unwrap();
        assert_eq!(stub.requests().len(), 0);

        let lock = fixtures::lock_env();
        fixtures::TestPubkeyEnv::clear();
        let unkeyed_stub = stub_center(unavailable_update(), Vec::new(), 204).await;
        let unkeyed_harness = setup(&unkeyed_stub, enabled()).await;
        let (_hello_tx, hello_rx) = watch::channel(false);
        let (_shutdown_tx, shutdown_rx) = watch::channel(false);
        tokio::time::timeout(
            Duration::from_secs(5),
            run(Arc::clone(&unkeyed_harness.daemon), hello_rx, shutdown_rx),
        )
        .await
        .unwrap();
        assert_eq!(unkeyed_stub.requests().len(), 0);
        drop(lock);
    }

    #[tokio::test]
    async fn no_check_before_the_first_hello() {
        let _lock = fixtures::lock_env();
        let _env = fixtures::TestPubkeyEnv::set();
        let stub = stub_center(unavailable_update(), Vec::new(), 204).await;
        let signal = Arc::new(Notify::new());
        let harness = setup_with_signal(&stub, enabled(), Some(Arc::clone(&signal))).await;
        let (hello_tx, hello_rx) = watch::channel(false);
        let (shutdown_tx, shutdown_rx) = watch::channel(false);
        let run = tokio::spawn(run(Arc::clone(&harness.daemon), hello_rx, shutdown_rx));
        tokio::time::timeout(Duration::from_secs(5), signal.notified())
            .await
            .expect("the daemon reaches the hello wait");
        assert_eq!(
            stub.requests().len(),
            0,
            "no update request may run before the first hello"
        );
        hello_tx.send(true).unwrap();
        stub.wait_for_until(1, Duration::from_secs(5))
            .await
            .unwrap();
        assert_eq!(stub.requests().len(), 1);
        assert!(stub.requests()[0].path.starts_with("/api/runners/update?"));
        shutdown_tx.send(true).unwrap();
        tokio::time::timeout(Duration::from_secs(5), run)
            .await
            .unwrap()
            .unwrap();
    }

    #[tokio::test(start_paused = true)]
    async fn stub_wait_for_returns_on_timeout() {
        let stub = stub_center(unavailable_update(), Vec::new(), 204).await;
        let started = tokio::time::Instant::now();
        let error = stub
            .wait_for_until(1, Duration::from_millis(50))
            .await
            .unwrap_err();
        assert!(error.contains("0 of 1"), "{error}");
        assert_eq!(
            tokio::time::Instant::now() - started,
            Duration::from_millis(50)
        );
    }

    #[tokio::test]
    async fn defers_a_release_when_auto_update_is_disabled() {
        let _lock = fixtures::lock_env();
        let _env = fixtures::TestPubkeyEnv::set();
        let archive = release_archive();
        let spec = ReleaseSpec::for_archive("0.3.0", &archive);
        let mut update = signed_update(&spec, &archive);
        update["autoUpdate"] = json!(false);
        update["pinnedVersion"] = json!("0.3.0");
        update["latestVersion"] = json!("0.3.0");
        let stub = stub_center(update, archive, 204).await;
        let harness = setup(&stub, enabled()).await;
        let outcome = check_once(&harness.daemon).await;
        assert_eq!(outcome, None);
        assert_eq!(stub.update_requests(), 1);
        assert_eq!(stub.artifact_requests(), 0);
        assert_eq!(stub.reports().len(), 0);
        assert_eq!(harness.installer.calls(), 0);
        assert_eq!(harness.installer.backups(), 0);
        assert_eq!(
            UpdateState::load(&harness.state_dir)
                .unwrap()
                .and_then(|state| state.pending),
            None
        );
        assert!(
            harness.jobs.begin_update(),
            "the update gate must be released"
        );
        harness.jobs.end_update();
    }
}
