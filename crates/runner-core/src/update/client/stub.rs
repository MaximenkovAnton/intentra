use std::net::SocketAddr;
use std::sync::{Arc, Mutex};

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

pub struct StubResponse {
    pub status: u16,
    pub content_type: &'static str,
    pub content_length: Option<usize>,
    pub body: Vec<u8>,
    pub hold_open: bool,
}

#[derive(Debug, Clone)]
pub struct RecordedRequest {
    pub path: String,
}

pub struct StubCenter {
    addr: SocketAddr,
    requests: Arc<Mutex<Vec<RecordedRequest>>>,
}

impl StubCenter {
    pub async fn start(responses: Vec<StubResponse>) -> StubCenter {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let addr = listener.local_addr().unwrap();
        let requests = Arc::new(Mutex::new(Vec::new()));
        let recorded = Arc::clone(&requests);
        tokio::spawn(async move {
            for response in responses {
                let Ok((mut stream, _)) = listener.accept().await else {
                    return;
                };
                match read_request(&mut stream).await {
                    Some(request) => recorded.lock().unwrap().push(request),
                    None => continue,
                }
                write_response(stream, response).await;
            }
        });
        StubCenter { addr, requests }
    }

    pub fn url(&self) -> String {
        format!("ws://{}", self.addr)
    }

    pub fn requests(&self) -> Vec<RecordedRequest> {
        self.requests.lock().unwrap().clone()
    }
}

fn reason(status: u16) -> &'static str {
    match status {
        200 => "OK",
        204 => "No Content",
        302 => "Found",
        _ => "Error",
    }
}

async fn write_response(mut stream: TcpStream, response: StubResponse) {
    let mut head = format!(
        "HTTP/1.1 {} {}\r\ncontent-type: {}\r\n",
        response.status,
        reason(response.status),
        response.content_type
    );
    if let Some(length) = response.content_length {
        head.push_str(&format!("content-length: {length}\r\n"));
    }
    head.push_str("connection: close\r\n\r\n");
    let _ = stream.write_all(head.as_bytes()).await;
    let _ = stream.write_all(&response.body).await;
    if response.hold_open {
        tokio::spawn(async move {
            let _stream = stream;
            std::future::pending::<()>().await;
        });
    } else {
        let _ = stream.shutdown().await;
    }
}

async fn read_request(stream: &mut TcpStream) -> Option<RecordedRequest> {
    let mut buffer = Vec::new();
    let mut chunk = [0u8; 4096];
    let end = loop {
        let read = stream.read(&mut chunk).await.ok()?;
        if read == 0 {
            return None;
        }
        buffer.extend_from_slice(&chunk[..read]);
        if let Some(end) = buffer.windows(4).position(|window| window == b"\r\n\r\n") {
            break end + 4;
        }
    };
    let header = String::from_utf8_lossy(&buffer[..end]).to_string();
    let path = header
        .split("\r\n")
        .next()?
        .split_whitespace()
        .nth(1)?
        .to_string();
    Some(RecordedRequest { path })
}
