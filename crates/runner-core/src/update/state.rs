use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::util::now_iso;

pub const UPDATE_STATE_FILE: &str = "update-state.json";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PendingUpdate {
    pub from: String,
    pub to: String,
    pub attempts: u32,
    pub staged_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConfirmedUpdate {
    pub version: String,
    pub confirmed_at: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpdateState {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pending: Option<PendingUpdate>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confirmed: Option<ConfirmedUpdate>,
}

impl UpdateState {
    pub fn path(state_dir: &Path) -> PathBuf {
        state_dir.join(UPDATE_STATE_FILE)
    }

    pub fn load(state_dir: &Path) -> std::io::Result<Option<UpdateState>> {
        match std::fs::read_to_string(UpdateState::path(state_dir)) {
            Ok(raw) => serde_json::from_str(&raw)
                .map(Some)
                .map_err(std::io::Error::other),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error),
        }
    }

    pub fn save(&self, state_dir: &Path) -> std::io::Result<()> {
        std::fs::create_dir_all(state_dir)?;
        let temp = state_dir.join(format!("{UPDATE_STATE_FILE}.tmp"));
        let body = serde_json::to_vec_pretty(self).map_err(std::io::Error::other)?;
        std::fs::write(&temp, body)?;
        std::fs::rename(&temp, UpdateState::path(state_dir))
    }

    pub fn pending_for(&self, version: &str) -> Option<&PendingUpdate> {
        self.pending
            .as_ref()
            .filter(|pending| pending.to == version)
    }

    pub fn attempts(&self) -> u32 {
        self.pending
            .as_ref()
            .map(|pending| pending.attempts)
            .unwrap_or(0)
    }

    pub fn confirm(&mut self, version: &str) {
        self.confirmed = Some(ConfirmedUpdate {
            version: version.to_string(),
            confirmed_at: now_iso(),
        });
        self.pending = None;
    }

    pub fn clear_pending(&mut self) {
        self.pending = None;
    }

    pub fn set_pending(&mut self, pending: PendingUpdate) {
        self.pending = Some(pending);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pending(attempts: u32) -> PendingUpdate {
        PendingUpdate {
            from: "0.1.0".to_string(),
            to: "0.2.0".to_string(),
            attempts,
            staged_at: "2026-11-27T18:00:00.000Z".to_string(),
        }
    }

    #[test]
    fn update_state_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(UpdateState::load(dir.path()).unwrap(), None);

        let state = UpdateState {
            pending: Some(pending(0)),
            confirmed: None,
        };
        state.save(dir.path()).unwrap();
        assert_eq!(UpdateState::load(dir.path()).unwrap(), Some(state.clone()));
        let raw = std::fs::read_to_string(UpdateState::path(dir.path())).unwrap();
        for key in [
            "\"pending\"",
            "\"attempts\"",
            "\"stagedAt\"",
            "\"from\"",
            "\"to\"",
        ] {
            assert!(raw.contains(key), "{key} must be serialized: {raw}");
        }

        let mut confirmed = state.clone();
        confirmed.confirm("0.2.0");
        confirmed.save(dir.path()).unwrap();
        let raw = std::fs::read_to_string(UpdateState::path(dir.path())).unwrap();
        assert!(raw.contains("\"confirmed\""));
        assert!(raw.contains("\"confirmedAt\""));
        assert!(!raw.contains("\"pending\""));
        let loaded = UpdateState::load(dir.path()).unwrap().unwrap();
        assert_eq!(
            loaded.confirmed.as_ref().map(|c| c.version.as_str()),
            Some("0.2.0")
        );
        assert_eq!(loaded.pending, None);

        std::fs::write(
            UpdateState::path(dir.path()),
            r#"{"pending":null,"unexpected":true}"#,
        )
        .unwrap();
        assert!(UpdateState::load(dir.path()).is_err());
    }
}
