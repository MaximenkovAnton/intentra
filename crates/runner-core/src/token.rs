use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredToken {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runner_id: Option<String>,
    pub token: String,
}

#[derive(Debug, thiserror::Error)]
pub enum TokenError {
    #[error("cannot read token file {path}: {source}")]
    Read {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("token file {path} is not valid JSON: {source}")]
    Parse {
        path: PathBuf,
        #[source]
        source: serde_json::Error,
    },
    #[error("token file {0} is accessible by other users; expected mode 0600")]
    Permissions(PathBuf),
    #[error("cannot write token file {path}: {source}")]
    Write {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
}

pub fn load(path: &Path) -> Result<StoredToken, TokenError> {
    check_private(path)?;
    let raw = std::fs::read_to_string(path).map_err(|source| TokenError::Read {
        path: path.to_path_buf(),
        source,
    })?;
    serde_json::from_str(&raw).map_err(|source| TokenError::Parse {
        path: path.to_path_buf(),
        source,
    })
}

pub fn save(path: &Path, token: &StoredToken) -> Result<(), TokenError> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|source| TokenError::Write {
            path: path.to_path_buf(),
            source,
        })?;
    }
    let body = serde_json::to_string(token).expect("token serializes");
    let temp = path.with_extension("tmp");
    write_private(&temp, body.as_bytes()).map_err(|source| TokenError::Write {
        path: temp.clone(),
        source,
    })?;
    std::fs::rename(&temp, path).map_err(|source| TokenError::Write {
        path: path.to_path_buf(),
        source,
    })?;
    Ok(())
}

#[cfg(unix)]
fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(path)?;
    file.write_all(bytes)
}

#[cfg(not(unix))]
fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    std::fs::write(path, bytes)
}

#[cfg(unix)]
pub fn check_private(path: &Path) -> Result<(), TokenError> {
    use std::os::unix::fs::PermissionsExt;
    let mode = std::fs::metadata(path)
        .map_err(|source| TokenError::Read {
            path: path.to_path_buf(),
            source,
        })?
        .permissions()
        .mode();
    if mode & 0o077 != 0 {
        return Err(TokenError::Permissions(path.to_path_buf()));
    }
    Ok(())
}

#[cfg(not(unix))]
pub fn check_private(_path: &Path) -> Result<(), TokenError> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_round_trips_with_private_permissions() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("token");
        let stored = StoredToken {
            runner_id: Some("runner-1".to_string()),
            token: "secret".to_string(),
        };
        save(&path, &stored).unwrap();
        assert_eq!(load(&path).unwrap(), stored);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
    }

    #[cfg(unix)]
    #[test]
    fn a_world_readable_token_file_is_rejected() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("token");
        save(
            &path,
            &StoredToken {
                runner_id: None,
                token: "secret".to_string(),
            },
        )
        .unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert!(matches!(load(&path), Err(TokenError::Permissions(_))));
    }
}
