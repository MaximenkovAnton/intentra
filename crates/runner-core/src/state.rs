use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::util::now_iso;

pub const STATE_FILE: &str = "state.json";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunnerState {
    pub version: String,
    pub pid: u32,
    pub started_at: String,
    pub server_url: String,
    pub mcp_addr: String,
}

impl RunnerState {
    pub fn new(server_url: &str, mcp_addr: &str) -> RunnerState {
        RunnerState {
            version: env!("CARGO_PKG_VERSION").to_string(),
            pid: std::process::id(),
            started_at: now_iso(),
            server_url: server_url.to_string(),
            mcp_addr: mcp_addr.to_string(),
        }
    }

    pub fn path(state_dir: &Path) -> PathBuf {
        state_dir.join(STATE_FILE)
    }

    pub fn write(&self, state_dir: &Path) -> std::io::Result<PathBuf> {
        std::fs::create_dir_all(state_dir)?;
        let path = RunnerState::path(state_dir);
        std::fs::write(&path, serde_json::to_string_pretty(self)?)?;
        Ok(path)
    }

    pub fn read(state_dir: &Path) -> std::io::Result<RunnerState> {
        let raw = std::fs::read_to_string(RunnerState::path(state_dir))?;
        serde_json::from_str(&raw).map_err(std::io::Error::other)
    }

    pub fn remove(state_dir: &Path) {
        let _ = std::fs::remove_file(RunnerState::path(state_dir));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn state_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        let state = RunnerState::new("wss://example.test/api/runner", "127.0.0.1:4555");
        state.write(dir.path()).unwrap();
        assert_eq!(RunnerState::read(dir.path()).unwrap(), state);
        RunnerState::remove(dir.path());
        assert!(!RunnerState::path(dir.path()).exists());
    }
}
