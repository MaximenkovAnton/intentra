use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Arc;

use intentra_runner_core::daemon::{JobTools, McpServer, Registry};
use intentra_runner_core::state::RunnerState;
use intentra_runner_core::verify;
use serde_json::json;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command as AsyncCommand;

fn binary() -> &'static str {
    env!("CARGO_BIN_EXE_intentra-runner")
}

fn git(dir: &Path, args: &[&str]) {
    let status = Command::new("git")
        .args(args)
        .current_dir(dir)
        .status()
        .expect("git CLI");
    assert!(status.success(), "git {args:?} failed");
}

fn init_repo(dir: &Path) {
    git(dir, &["init", "-q", "-b", "main"]);
    git(dir, &["config", "user.email", "runner@example.test"]);
    git(dir, &["config", "user.name", "Intentra Runner"]);
    std::fs::write(dir.join("README.md"), "hello\n").unwrap();
    git(dir, &["add", "."]);
    git(dir, &["commit", "-q", "-m", "initial"]);
}

fn toml_path(path: &Path) -> String {
    // Windows paths contain backslashes, which are escapes inside a TOML basic
    // string; forward slashes are valid in a Windows path and in TOML.
    path.display().to_string().replace('\\', "/")
}

const FIXTURE_MANIFEST: &str = include_str!("../../../fixtures/release/manifest.json");
const FIXTURE_SIGNATURE: &str = include_str!("../../../fixtures/release/manifest.sig");
const TEST_PUBKEY: &str = include_str!("../../../fixtures/release/test.pub");
const TEST_SEED: &str = include_str!("../../../fixtures/release/test.seed");

fn write_update_config(dir: &Path, token_path: &Path, server_url: &str) -> PathBuf {
    let config = format!(
        "server_url = \"{server_url}\"\ntoken_path = \"{}\"\n\n[update]\nallow_insecure_http = true\n",
        toml_path(token_path)
    );
    let path = dir.join("update-config.toml");
    std::fs::write(&path, config).unwrap();
    path
}

fn base64_encode(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut output = String::new();
    for chunk in bytes.chunks(3) {
        let first = u32::from(chunk[0]);
        let second = u32::from(chunk.get(1).copied().unwrap_or(0));
        let third = u32::from(chunk.get(2).copied().unwrap_or(0));
        let value = (first << 16) | (second << 8) | third;
        output.push(ALPHABET[(value >> 18 & 63) as usize] as char);
        output.push(ALPHABET[(value >> 12 & 63) as usize] as char);
        output.push(if chunk.len() > 1 {
            ALPHABET[(value >> 6 & 63) as usize] as char
        } else {
            '='
        });
        output.push(if chunk.len() > 2 {
            ALPHABET[(value & 63) as usize] as char
        } else {
            '='
        });
    }
    output
}

fn base64_decode(input: &str) -> Vec<u8> {
    fn digit(byte: u8) -> Option<u8> {
        match byte {
            b'A'..=b'Z' => Some(byte - b'A'),
            b'a'..=b'z' => Some(byte - b'a' + 26),
            b'0'..=b'9' => Some(byte - b'0' + 52),
            b'+' => Some(62),
            b'/' => Some(63),
            _ => None,
        }
    }
    let bytes = input.as_bytes();
    let content = bytes
        .iter()
        .position(|byte| *byte == b'=')
        .unwrap_or(bytes.len());
    let mut output = Vec::new();
    let mut buffer = 0u32;
    let mut digits = 0usize;
    for byte in &bytes[..content] {
        buffer = (buffer << 6) | u32::from(digit(*byte).expect("valid base64"));
        digits += 1;
        if digits == 4 {
            output.push((buffer >> 16) as u8);
            output.push((buffer >> 8) as u8);
            output.push(buffer as u8);
            buffer = 0;
            digits = 0;
        }
    }
    match digits {
        2 => output.push((buffer >> 4) as u8),
        3 => {
            output.push((buffer >> 10) as u8);
            output.push((buffer >> 2) as u8);
        }
        _ => {}
    }
    output
}

fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn sign_manifest(manifest: &[u8]) -> String {
    use ed25519_dalek::Signer;
    let seed_bytes = base64_decode(TEST_SEED.trim());
    let seed: [u8; 32] = seed_bytes.as_slice().try_into().expect("seed is 32 bytes");
    let key = ed25519_dalek::SigningKey::from_bytes(&seed);
    base64_encode(&key.sign(manifest).to_bytes())
}

fn signed_update(archive: &[u8]) -> Vec<u8> {
    let targets = [
        "x86_64-unknown-linux-gnu",
        "aarch64-unknown-linux-gnu",
        "x86_64-apple-darwin",
        "aarch64-apple-darwin",
        "x86_64-pc-windows-msvc",
    ];
    let assets: Vec<serde_json::Value> = targets
        .iter()
        .map(|target| {
            json!({
                "target": target,
                "fileName": format!("intentra-runner-0.2.0-{target}.archive"),
                "url": format!("https://example.test/{target}.archive"),
                "sizeBytes": archive.len(),
                "sha256": sha256_hex(archive),
            })
        })
        .collect();
    let manifest = json!({
        "schemaVersion": 1,
        "version": "0.2.0",
        "channel": "stable",
        "protocolVersion": 1,
        "publishedAt": "2026-11-27T18:00:00Z",
        "notes": "cli test release",
        "assets": assets,
    });
    let manifest_bytes = serde_json::to_vec(&manifest).unwrap();
    serde_json::to_vec(&json!({
        "available": true,
        "channel": "stable",
        "latestVersion": "0.2.0",
        "pinnedVersion": null,
        "autoUpdate": true,
        "manifest": String::from_utf8(manifest_bytes.clone()).unwrap(),
        "signature": sign_manifest(&manifest_bytes),
    }))
    .unwrap()
}

#[cfg(unix)]
fn archive(entries: &[(&str, &[u8])]) -> Vec<u8> {
    use flate2::Compression;
    use flate2::write::GzEncoder;

    let encoder = GzEncoder::new(Vec::new(), Compression::default());
    let mut builder = tar::Builder::new(encoder);
    for (name, bytes) in entries {
        let mut header = tar::Header::new_gnu();
        header.set_size(bytes.len() as u64);
        header.set_mode(0o755);
        header.set_cksum();
        builder
            .append_data(&mut header, *name, std::io::Cursor::new(*bytes))
            .unwrap();
    }
    builder.into_inner().unwrap().finish().unwrap()
}

#[cfg(windows)]
fn archive(entries: &[(&str, &[u8])]) -> Vec<u8> {
    let mut writer = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    for (name, bytes) in entries {
        writer
            .start_file(*name, zip::write::SimpleFileOptions::default())
            .unwrap();
        writer.write_all(bytes).unwrap();
    }
    writer.finish().unwrap().into_inner()
}

#[cfg(unix)]
const ARCHIVE_BINARY: &str = "intentra-runner";
#[cfg(windows)]
const ARCHIVE_BINARY: &str = "intentra-runner.exe";

fn header_end(buffer: &[u8]) -> Option<usize> {
    buffer
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .map(|i| i + 4)
}

fn serve_http(
    responses: Vec<(u16, &'static str, Vec<u8>)>,
) -> (SocketAddr, std::thread::JoinHandle<Vec<String>>) {
    let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let addr = listener.local_addr().unwrap();
    let handle = std::thread::spawn(move || {
        let mut requests = Vec::new();
        for (status, content_type, body) in responses {
            let (mut stream, _) = listener.accept().unwrap();
            let mut buffer = Vec::new();
            let mut chunk = [0u8; 4096];
            let end = loop {
                let read = stream.read(&mut chunk).unwrap_or(0);
                if read == 0 {
                    break buffer.len();
                }
                buffer.extend_from_slice(&chunk[..read]);
                if let Some(end) = header_end(&buffer) {
                    break end;
                }
            };
            let header = String::from_utf8_lossy(&buffer[..end]).to_string();
            requests.push(header.lines().next().unwrap_or_default().to_string());
            let reason = match status {
                200 => "OK",
                204 => "No Content",
                _ => "Error",
            };
            let head = format!(
                "HTTP/1.1 {status} {reason}\r\ncontent-type: {content_type}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                body.len()
            );
            stream.write_all(head.as_bytes()).unwrap();
            stream.write_all(&body).unwrap();
        }
        requests
    });
    (addr, handle)
}

fn write_config(dir: &Path, token_path: &Path) -> PathBuf {
    let config = format!(
        "server_url = \"wss://intentra.example/api/runner\"\ntoken_path = \"{}\"\nallow_roots = [\"{}\"]\nlog_level = \"info\"\nmax_concurrent_jobs = 1\n\n[workspaces]\np = \"{}\"\n",
        toml_path(token_path),
        toml_path(dir),
        toml_path(dir)
    );
    let path = dir.join("config.toml");
    std::fs::write(&path, config).unwrap();
    path
}

fn write_token(path: &Path) {
    std::fs::write(path, r#"{"runnerId":"runner-1","token":"runner-secret"}"#).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)).unwrap();
    }
}

#[test]
fn version_and_help_describe_every_command() {
    let version = Command::new(binary()).arg("--version").output().unwrap();
    assert!(version.status.success());
    assert!(String::from_utf8_lossy(&version.stdout).contains(env!("CARGO_PKG_VERSION")));
    let help = Command::new(binary()).arg("--help").output().unwrap();
    let text = String::from_utf8_lossy(&help.stdout);
    for command in ["register", "start", "status", "doctor", "mcp", "update"] {
        assert!(text.contains(command), "help must list {command}: {text}");
    }
}

#[test]
fn doctor_passes_on_a_valid_config_and_status_reads_the_state_file() {
    let dir = tempfile::tempdir().unwrap();
    let token = dir.path().join("token");
    write_token(&token);
    let config = write_config(dir.path(), &token);
    let doctor = Command::new(binary())
        .args(["doctor", "--config"])
        .arg(&config)
        .output()
        .unwrap();
    let stdout = String::from_utf8_lossy(&doctor.stdout);
    assert!(doctor.status.success(), "doctor failed: {stdout}");
    assert!(stdout.contains("ok   git"));
    assert!(stdout.contains("ok   token"));

    let missing = Command::new(binary())
        .args(["status", "--config"])
        .arg(&config)
        .output()
        .unwrap();
    assert_eq!(missing.status.code(), Some(5));
    assert!(String::from_utf8_lossy(&missing.stdout).contains("\"running\":false"));

    let state = RunnerState::new("wss://intentra.example/api/runner", "127.0.0.1:4555");
    state.write(dir.path()).unwrap();
    let running = Command::new(binary())
        .args(["status", "--config"])
        .arg(&config)
        .output()
        .unwrap();
    assert_eq!(running.status.code(), Some(0));
    assert!(String::from_utf8_lossy(&running.stdout).contains("\"running\":true"));
}

#[tokio::test]
async fn mcp_over_stdio_answers_list_and_call() {
    let dir = tempfile::tempdir().unwrap();
    init_repo(dir.path());
    std::fs::write(dir.path().join("lib.ts"), "export function find_me() {}\n").unwrap();
    git(dir.path(), &["add", "."]);
    git(dir.path(), &["commit", "-q", "-m", "lib"]);
    let repo_root = dir.path().canonicalize().unwrap();
    let registry = Registry::new();
    let token = registry.register(
        "job-1",
        JobTools {
            job_id: "job-1".to_string(),
            worktree: repo_root.clone(),
            evidence_dir: verify::evidence_dir(&repo_root, "job-1").unwrap(),
            repo_root,
            role: None,
        },
    );
    let server = McpServer::bind(Arc::clone(&registry)).await.unwrap();
    let mut child = AsyncCommand::new(binary())
        .args(["mcp", "--job", "job-1", "--socket", &server.endpoint()])
        .env("INTENTRA_JOB_TOKEN", &token)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    let mut stdout = BufReader::new(child.stdout.take().unwrap());
    let exchanges = [
        (
            json!({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}}),
            "\"protocolVersion\"",
        ),
        (
            json!({"jsonrpc": "2.0", "id": 2, "method": "tools/list"}),
            "repo_search",
        ),
        (
            json!({"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "repo_search", "arguments": {"query": "find"}}}),
            "find_me",
        ),
    ];
    for (request, needle) in exchanges {
        stdin
            .write_all(format!("{request}\n").as_bytes())
            .await
            .unwrap();
        stdin.flush().await.unwrap();
        let mut line = String::new();
        tokio::time::timeout(
            std::time::Duration::from_secs(20),
            stdout.read_line(&mut line),
        )
        .await
        .expect("mcp answers")
        .unwrap();
        assert!(line.contains(needle), "expected {needle} in {line}");
    }
    drop(stdin);
    let _ = child.kill().await;
}

#[test]
fn update_prints_the_available_release() {
    let dir = tempfile::tempdir().unwrap();
    let token = dir.path().join("token");
    write_token(&token);
    let update = json!({
        "available": true,
        "channel": "stable",
        "latestVersion": "0.2.0",
        "pinnedVersion": null,
        "autoUpdate": true,
        "manifest": FIXTURE_MANIFEST,
        "signature": FIXTURE_SIGNATURE.trim(),
    });
    let (addr, server) = serve_http(vec![(
        200,
        "application/json",
        serde_json::to_vec(&update).unwrap(),
    )]);
    let config = write_update_config(dir.path(), &token, &format!("ws://{addr}"));
    let output = Command::new(binary())
        .args(["update", "--config"])
        .arg(&config)
        .output()
        .unwrap();
    assert_eq!(
        output.status.code(),
        Some(0),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let value: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(value["current"], env!("CARGO_PKG_VERSION"));
    assert_eq!(value["latest"], "0.2.0");
    assert_eq!(value["channel"], "stable");
    assert_eq!(value["available"], true);
    for key in ["pinnedVersion", "autoUpdate", "reason"] {
        assert!(value.get(key).is_some(), "{key} must be in the status JSON");
    }
    let requests = server.join().unwrap();
    assert_eq!(requests.len(), 1);
    assert!(requests[0].starts_with("GET /api/runners/update?"));
}

#[test]
fn update_without_a_token_exits_with_auth_error() {
    let dir = tempfile::tempdir().unwrap();
    let token = dir.path().join("missing-token");
    let config = write_update_config(dir.path(), &token, "ws://127.0.0.1:1");
    let output = Command::new(binary())
        .args(["update", "--config"])
        .arg(&config)
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(4));
}

#[test]
fn update_apply_refuses_while_the_daemon_is_running() {
    let dir = tempfile::tempdir().unwrap();
    let token = dir.path().join("token");
    write_token(&token);
    let config = write_update_config(dir.path(), &token, "ws://127.0.0.1:1");
    let state = RunnerState::new("wss://intentra.example/api/runner", "127.0.0.1:4555");
    state.write(dir.path()).unwrap();
    let output = Command::new(binary())
        .args(["update", "--apply", "--config"])
        .arg(&config)
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(1));
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("daemon is running"),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn update_apply_refuses_when_auto_update_is_disabled() {
    let dir = tempfile::tempdir().unwrap();
    let token = dir.path().join("token");
    write_token(&token);
    let copied = dir
        .path()
        .join(format!("runner-copy{}", std::env::consts::EXE_SUFFIX));
    std::fs::copy(binary(), &copied).unwrap();
    let copied = copied.canonicalize().unwrap();
    let original = std::fs::read(&copied).unwrap();
    let update = json!({
        "available": true,
        "channel": "stable",
        "latestVersion": "0.3.0",
        "pinnedVersion": null,
        "autoUpdate": false,
        "manifest": FIXTURE_MANIFEST,
        "signature": FIXTURE_SIGNATURE.trim(),
    });
    let (addr, server) = serve_http(vec![(
        200,
        "application/json",
        serde_json::to_vec(&update).unwrap(),
    )]);
    let config = write_update_config(dir.path(), &token, &format!("ws://{addr}"));
    let output = Command::new(&copied)
        .args(["update", "--apply", "--config"])
        .arg(&config)
        .output()
        .unwrap();
    assert_eq!(
        output.status.code(),
        Some(1),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(
        String::from_utf8_lossy(&output.stderr).contains(
            "update: auto-updates are disabled for this runner (autoUpdate=false); enable auto-update in the centre before applying"
        ),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(std::fs::read(&copied).unwrap(), original);
    let requests = server.join().unwrap();
    assert_eq!(requests.len(), 1);
    assert!(requests[0].starts_with("GET /api/runners/update?"));
}

#[test]
fn update_apply_replaces_the_binary() {
    let dir = tempfile::tempdir().unwrap();
    let token = dir.path().join("token");
    write_token(&token);
    let copied = dir
        .path()
        .join(format!("runner-copy{}", std::env::consts::EXE_SUFFIX));
    std::fs::copy(binary(), &copied).unwrap();
    let copied = copied.canonicalize().unwrap();
    let original = std::fs::read(&copied).unwrap();
    let replacement: &[u8] = b"#!/bin/sh\necho 0.2.0\n";
    let archive = archive(&[(ARCHIVE_BINARY, replacement), ("LICENSE", b"MIT\n")]);
    let (addr, server) = serve_http(vec![
        (200, "application/json", signed_update(&archive)),
        (200, "application/octet-stream", archive),
    ]);
    let config = write_update_config(dir.path(), &token, &format!("ws://{addr}"));
    let output = Command::new(&copied)
        .args(["update", "--apply", "--config"])
        .arg(&config)
        .env("INTENTRA_UPDATE_PUBKEY", TEST_PUBKEY.trim())
        .output()
        .unwrap();
    assert_eq!(
        output.status.code(),
        Some(0),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(std::fs::read(&copied).unwrap(), replacement);
    let mut backup = copied.as_os_str().to_owned();
    backup.push(".prev");
    assert_eq!(std::fs::read(PathBuf::from(backup)).unwrap(), original);
    let requests = server.join().unwrap();
    assert_eq!(requests.len(), 2);
    assert!(requests[1].starts_with("GET /api/runners/update/artifact/"));
}
