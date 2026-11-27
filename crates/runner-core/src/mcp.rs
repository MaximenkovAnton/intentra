use std::net::SocketAddr;

use serde_json::{Value, json};
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::net::TcpStream;
use tokio::net::tcp::{OwnedReadHalf, OwnedWriteHalf};

use crate::daemon;

pub const SERVER_NAME: &str = "intentra-runner";
pub const MCP_PROTOCOL_VERSION: &str = "2024-11-05";
const DAEMON_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);

#[derive(Debug, thiserror::Error)]
pub enum McpError {
    #[error("cannot reach the runner daemon: {0}")]
    Io(#[from] std::io::Error),
    #[error("the runner daemon rejected the job token")]
    Auth,
    #[error("the runner daemon did not answer in time")]
    Timeout,
    #[error("the runner daemon returned an invalid frame: {0}")]
    Protocol(String),
}

#[derive(Debug)]
pub struct DaemonClient {
    reader: BufReader<OwnedReadHalf>,
    writer: OwnedWriteHalf,
    next_id: u64,
}

impl DaemonClient {
    pub async fn connect(
        addr: SocketAddr,
        job_id: &str,
        token: &str,
    ) -> Result<DaemonClient, McpError> {
        let stream = TcpStream::connect(addr).await?;
        let (read_half, mut writer) = stream.into_split();
        let request = json!({"type": "auth", "jobId": job_id, "token": token});
        writer.write_all(format!("{request}\n").as_bytes()).await?;
        let mut reader = BufReader::new(read_half);
        let mut line = String::new();
        tokio::time::timeout(DAEMON_TIMEOUT, reader.read_line(&mut line))
            .await
            .map_err(|_| McpError::Timeout)??;
        let reply: Value = serde_json::from_str(line.trim_end())
            .map_err(|error| McpError::Protocol(error.to_string()))?;
        if reply.get("ok").and_then(Value::as_bool) != Some(true) {
            return Err(McpError::Auth);
        }
        Ok(DaemonClient {
            reader,
            writer,
            next_id: 1,
        })
    }

    pub async fn call_tool(&mut self, tool: &str, args: &Value) -> Result<Value, String> {
        let id = self.next_id;
        self.next_id += 1;
        let request = json!({"type": "call", "id": id, "tool": tool, "args": args});
        self.writer
            .write_all(format!("{request}\n").as_bytes())
            .await
            .map_err(|error| error.to_string())?;
        let mut line = String::new();
        tokio::time::timeout(DAEMON_TIMEOUT, self.reader.read_line(&mut line))
            .await
            .map_err(|_| "the runner daemon did not answer in time".to_string())?
            .map_err(|error| error.to_string())?;
        let reply: Value = serde_json::from_str(line.trim_end())
            .map_err(|error| format!("invalid daemon reply: {error}"))?;
        if reply.get("ok").and_then(Value::as_bool) == Some(true) {
            Ok(reply.get("result").cloned().unwrap_or(Value::Null))
        } else {
            Err(reply
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("daemon call failed")
                .to_string())
        }
    }
}

fn initialize_result(params: &Value) -> Value {
    let version = params
        .get("protocolVersion")
        .and_then(Value::as_str)
        .unwrap_or(MCP_PROTOCOL_VERSION);
    json!({
        "protocolVersion": version,
        "capabilities": {"tools": {}},
        "serverInfo": {"name": SERVER_NAME, "version": env!("CARGO_PKG_VERSION")}
    })
}

pub async fn serve_stdio<R, W>(
    input: R,
    mut output: W,
    daemon: &mut DaemonClient,
) -> Result<(), McpError>
where
    R: AsyncBufRead + Unpin,
    W: AsyncWrite + Unpin,
{
    let mut lines = input.lines();
    loop {
        let Some(line) = lines.next_line().await? else {
            return Ok(());
        };
        let line = line.trim().to_string();
        if line.is_empty() {
            continue;
        }
        let request: Value = match serde_json::from_str(&line) {
            Ok(request) => request,
            Err(error) => {
                let reply = json!({"jsonrpc": "2.0", "id": Value::Null, "error": {"code": -32700, "message": format!("parse error: {error}")}});
                write_line(&mut output, &reply).await?;
                continue;
            }
        };
        let id = request.get("id").cloned();
        let method = request
            .get("method")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let Some(id) = id else {
            continue;
        };
        let params = request.get("params").cloned().unwrap_or(Value::Null);
        let reply = match method.as_str() {
            "initialize" => {
                json!({"jsonrpc": "2.0", "id": id, "result": initialize_result(&params)})
            }
            "tools/list" => {
                json!({"jsonrpc": "2.0", "id": id, "result": {"tools": daemon_tool_definitions()}})
            }
            "tools/call" => {
                let name = params
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let arguments = params
                    .get("arguments")
                    .cloned()
                    .unwrap_or_else(|| json!({}));
                match daemon.call_tool(name, &arguments).await {
                    Ok(result) => json!({
                        "jsonrpc": "2.0",
                        "id": id,
                        "result": {
                            "content": [{"type": "text", "text": serde_json::to_string_pretty(&result).unwrap_or_default()}],
                            "isError": false
                        }
                    }),
                    Err(error) => json!({
                        "jsonrpc": "2.0",
                        "id": id,
                        "result": {
                            "content": [{"type": "text", "text": error}],
                            "isError": true
                        }
                    }),
                }
            }
            "ping" => json!({"jsonrpc": "2.0", "id": id, "result": {}}),
            other => json!({
                "jsonrpc": "2.0",
                "id": id,
                "error": {"code": -32601, "message": format!("method not found: {other}")}
            }),
        };
        write_line(&mut output, &reply).await?;
    }
}

fn daemon_tool_definitions() -> Value {
    daemon::tool_definitions()
}

async fn write_line<W: AsyncWrite + Unpin>(output: &mut W, value: &Value) -> Result<(), McpError> {
    let mut line = serde_json::to_string(value).expect("json-rpc reply serializes");
    line.push('\n');
    output.write_all(line.as_bytes()).await?;
    output.flush().await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    use crate::daemon::{JobTools, McpServer, Registry};

    fn job() -> (tempfile::TempDir, JobTools) {
        let dir = tempfile::tempdir().unwrap();
        crate::git::tests_support::init_repo(dir.path());
        std::fs::write(dir.path().join("lib.ts"), "export function find_me() {}\n").unwrap();
        crate::git::tests_support::run(dir.path(), &["add", "."]);
        crate::git::tests_support::run(dir.path(), &["commit", "-q", "-m", "lib"]);
        let repo_root = dir.path().canonicalize().unwrap();
        let tools = JobTools {
            job_id: "job-1".to_string(),
            worktree: repo_root.clone(),
            evidence_dir: repo_root.join(".intentra/evidence/job-1"),
            repo_root,
            role: None,
        };
        (dir, tools)
    }

    async fn client_and_server() -> (DaemonClient, tempfile::TempDir, Arc<Registry>) {
        let (dir, tools) = job();
        let registry = Registry::new();
        let token = registry.register("job-1", tools);
        let server = McpServer::bind(Arc::clone(&registry)).await.unwrap();
        let client = DaemonClient::connect(server.addr, "job-1", &token)
            .await
            .expect("daemon accepts the token");
        (client, dir, registry)
    }

    #[tokio::test]
    async fn stdio_answers_initialize_list_and_call() {
        let (mut daemon_client, _dir, _registry) = client_and_server().await;
        let (mut client_write, server_read) = tokio::io::duplex(64 * 1024);
        let (server_write, client_read) = tokio::io::duplex(64 * 1024);
        let server = tokio::spawn(async move {
            serve_stdio(
                BufReader::new(server_read),
                server_write,
                &mut daemon_client,
            )
            .await
        });
        let mut reader = BufReader::new(client_read);
        let exchanges = [
            (
                json!({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2024-11-05"}}),
                "protocolVersion",
            ),
            (
                json!({"jsonrpc": "2.0", "id": 2, "method": "tools/list"}),
                "repo_search",
            ),
            (
                json!({"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "repo_search", "arguments": {"query": "find"}}}),
                "find_me",
            ),
            (
                json!({"jsonrpc": "2.0", "id": 4, "method": "nope"}),
                "-32601",
            ),
        ];
        for (request, needle) in exchanges {
            client_write
                .write_all(format!("{request}\n").as_bytes())
                .await
                .unwrap();
            let mut line = String::new();
            reader.read_line(&mut line).await.unwrap();
            assert!(line.contains(needle), "expected {needle} in {line}");
        }
        drop(client_write);
        server.await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn a_wrong_token_never_reaches_a_tool() {
        let (_dir, tools) = job();
        let registry = Registry::new();
        registry.register("job-1", tools);
        let server = McpServer::bind(Arc::clone(&registry)).await.unwrap();
        let error = DaemonClient::connect(server.addr, "job-1", "wrong")
            .await
            .expect_err("bad token is refused");
        assert!(matches!(error, McpError::Auth));
    }
}
