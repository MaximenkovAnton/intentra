use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tokio::process::Command;

use crate::git::{self, GitError};
use crate::index::Index;
use crate::protocol::DiffSummary;
use crate::util::{resolve_inside, sha256_hex, tail, validate_job_id};

pub const OUTPUT_TAIL_BYTES: usize = 4096;
pub const DEFAULT_GATE_TIMEOUT_SECONDS: u64 = 300;
pub const MAX_GATE_TIMEOUT_SECONDS: u64 = 86_400;

#[derive(Debug, thiserror::Error)]
pub enum VerifyError {
    #[error("invalid cwd {0}")]
    InvalidCwd(String),
    #[error("gate command must not be empty")]
    EmptyCommand,
    #[error("gate command {0} has no executable")]
    MissingExecutable(String),
    #[error(transparent)]
    Git(#[from] GitError),
    #[error("index error: {0}")]
    Index(#[from] crate::index::IndexError),
    #[error("cannot write evidence {path}: {source}")]
    Evidence {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("invalid job id for evidence: {0}")]
    JobId(String),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GateSpec {
    pub criterion: String,
    pub command: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(default = "default_timeout")]
    pub timeout_seconds: u64,
}

fn default_timeout() -> u64 {
    DEFAULT_GATE_TIMEOUT_SECONDS
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GateOutcome {
    pub criterion: String,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    pub duration_ms: u64,
    pub output_sha256: String,
    pub output_tail: String,
    pub command: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Claim {
    pub id: String,
    pub probe: ClaimProbe,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blob_sha: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ClaimProbe {
    FileLine {
        path: String,
        line: u32,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        contains: Option<String>,
    },
    Symbol {
        path: String,
        symbol: String,
    },
    Command {
        command: Vec<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cwd: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        timeout_seconds: Option<u64>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaimVerdict {
    pub claim_id: String,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blob_sha: Option<String>,
    pub detail: String,
}

fn minimal_env(command: &mut Command) {
    command.env_clear();
    for key in [
        "PATH",
        "HOME",
        "USERPROFILE",
        "TMPDIR",
        "TMP",
        "TEMP",
        "SystemRoot",
        "ComSpec",
        "PATHEXT",
        "LANG",
        "LC_ALL",
    ] {
        if let Some(value) = std::env::var_os(key) {
            command.env(key, value);
        }
    }
}

fn resolve_program(program: &str) -> Result<PathBuf, VerifyError> {
    let path = Path::new(program);
    if path.is_absolute() || program.contains('/') || program.contains('\\') {
        return Ok(path.to_path_buf());
    }
    let search_path = std::env::var_os("PATH").unwrap_or_default();
    let extensions: Vec<String> = if cfg!(windows) {
        std::env::var("PATHEXT")
            .unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".to_string())
            .split(';')
            .map(str::to_string)
            .collect()
    } else {
        vec![String::new()]
    };
    for dir in std::env::split_paths(&search_path) {
        for extension in &extensions {
            let candidate = dir.join(format!("{program}{extension}"));
            if candidate.is_file() {
                return Ok(candidate);
            }
        }
    }
    Err(VerifyError::MissingExecutable(program.to_string()))
}

pub async fn run_gate(worktree: &Path, spec: &GateSpec) -> Result<GateOutcome, VerifyError> {
    if spec.command.is_empty() {
        return Err(VerifyError::EmptyCommand);
    }
    let cwd = match spec.cwd.as_deref() {
        Some(relative) if !relative.is_empty() => resolve_inside(worktree, relative)
            .map_err(|_| VerifyError::InvalidCwd(relative.to_string()))?,
        _ => worktree.to_path_buf(),
    };
    let program = resolve_program(&spec.command[0])?;
    let timeout_seconds = spec.timeout_seconds.clamp(1, MAX_GATE_TIMEOUT_SECONDS);
    let mut command = Command::new(program);
    command
        .args(&spec.command[1..])
        .current_dir(&cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    minimal_env(&mut command);
    let started = Instant::now();
    let outcome =
        tokio::time::timeout(Duration::from_secs(timeout_seconds), command.output()).await;
    let duration_ms = started.elapsed().as_millis() as u64;
    let (status, exit_code, full_output) = match outcome {
        Ok(Ok(output)) => {
            let mut body = String::from_utf8_lossy(&output.stdout).to_string();
            body.push_str(&String::from_utf8_lossy(&output.stderr));
            let status = if output.status.success() {
                "passed"
            } else {
                "failed"
            };
            (status, output.status.code(), body)
        }
        Ok(Err(error)) => ("error", None, format!("cannot start gate: {error}\n")),
        Err(_) => (
            "timeout",
            None,
            format!("gate timed out after {timeout_seconds}s\n"),
        ),
    };
    Ok(GateOutcome {
        criterion: spec.criterion.clone(),
        status: status.to_string(),
        exit_code,
        duration_ms,
        output_sha256: sha256_hex(full_output.as_bytes()),
        output_tail: tail(&full_output, OUTPUT_TAIL_BYTES),
        command: spec.command.clone(),
    })
}

pub async fn verify_claim(worktree: &Path, claim: &Claim) -> Result<ClaimVerdict, VerifyError> {
    match &claim.probe {
        ClaimProbe::FileLine {
            path,
            line,
            contains,
        } => {
            let blob_sha = git::blob_sha_at(worktree, path).ok();
            if let (Some(expected), Some(actual)) = (&claim.blob_sha, &blob_sha)
                && expected != actual
            {
                return Ok(verdict(
                    claim,
                    "stale",
                    blob_sha,
                    "file changed since the claim was recorded",
                ));
            }
            let body = match crate::util::resolve_inside(worktree, path)
                .and_then(std::fs::read_to_string)
            {
                Ok(body) => body,
                Err(error) => {
                    return Ok(verdict(
                        claim,
                        "stale",
                        blob_sha,
                        format!("cannot read {path}: {error}"),
                    ));
                }
            };
            let Some(text) = body.lines().nth((*line).saturating_sub(1) as usize) else {
                return Ok(verdict(claim, "stale", blob_sha, "line is out of range"));
            };
            if let Some(needle) = contains
                && !text.contains(needle)
            {
                return Ok(verdict(
                    claim,
                    "stale",
                    blob_sha,
                    format!("line {line} no longer contains {needle:?}"),
                ));
            }
            Ok(verdict(claim, "fresh", blob_sha, "file line matches"))
        }
        ClaimProbe::Symbol { path, symbol } => {
            let blob_sha = git::blob_sha_at(worktree, path).ok();
            if let (Some(expected), Some(actual)) = (&claim.blob_sha, &blob_sha)
                && expected != actual
            {
                return Ok(verdict(
                    claim,
                    "stale",
                    blob_sha,
                    "file changed since the claim was recorded",
                ));
            }
            let tree_hash = git::tree_hash_at(worktree).unwrap_or_default();
            let index = Index::build(worktree, &tree_hash)?;
            let outline = index.outline(Some(path))?;
            for entry in outline {
                if entry.symbols.iter().any(|found| &found.name == symbol) {
                    return Ok(verdict(
                        claim,
                        "fresh",
                        blob_sha,
                        format!("symbol {symbol} present in {path}"),
                    ));
                }
            }
            Ok(verdict(
                claim,
                "stale",
                blob_sha,
                format!("symbol {symbol} not found in {path}"),
            ))
        }
        ClaimProbe::Command {
            command,
            cwd,
            timeout_seconds,
        } => {
            let outcome = run_gate(
                worktree,
                &GateSpec {
                    criterion: claim.id.clone(),
                    command: command.clone(),
                    cwd: cwd.clone(),
                    timeout_seconds: timeout_seconds.unwrap_or(DEFAULT_GATE_TIMEOUT_SECONDS),
                },
            )
            .await?;
            let status = if outcome.status == "passed" {
                "fresh"
            } else {
                "stale"
            };
            Ok(verdict(
                claim,
                status,
                None,
                format!(
                    "command {} {}",
                    outcome.status,
                    outcome
                        .exit_code
                        .map(|code| format!("with exit {code}"))
                        .unwrap_or_default()
                ),
            ))
        }
    }
}

fn verdict(
    claim: &Claim,
    status: &str,
    blob_sha: Option<String>,
    detail: impl Into<String>,
) -> ClaimVerdict {
    ClaimVerdict {
        claim_id: claim.id.clone(),
        status: status.to_string(),
        blob_sha,
        detail: detail.into(),
    }
}

pub fn diff_summary(worktree: &Path, base: Option<&str>) -> Result<DiffSummary, VerifyError> {
    Ok(git::diff_summary_at(worktree, base)?)
}

pub fn evidence_dir(repo_root: &Path, job_id: &str) -> Result<PathBuf, VerifyError> {
    if !validate_job_id(job_id) {
        return Err(VerifyError::JobId(job_id.to_string()));
    }
    Ok(repo_root
        .join(crate::git::INTENTRA_DIR)
        .join("evidence")
        .join(job_id))
}

pub fn record_gate(evidence_dir: &Path, outcome: &GateOutcome) -> Result<PathBuf, VerifyError> {
    let name = format!(
        "gate-{}-{}.json",
        crate::util::slug(&outcome.criterion),
        &outcome.output_sha256[..12]
    );
    write_json(evidence_dir, &name, outcome)
}

pub fn record_claim(evidence_dir: &Path, verdict: &ClaimVerdict) -> Result<PathBuf, VerifyError> {
    let name = format!("claim-{}.json", crate::util::slug(&verdict.claim_id));
    write_json(evidence_dir, &name, verdict)
}

fn write_json<T: Serialize>(dir: &Path, name: &str, value: &T) -> Result<PathBuf, VerifyError> {
    std::fs::create_dir_all(dir).map_err(|source| VerifyError::Evidence {
        path: dir.to_path_buf(),
        source,
    })?;
    let path = dir.join(name);
    let body = serde_json::to_string_pretty(value).expect("evidence serializes");
    std::fs::write(&path, body).map_err(|source| VerifyError::Evidence {
        path: path.clone(),
        source,
    })?;
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn git_repo(dir: &Path) -> git::Repo {
        crate::git::tests_support::init_repo(dir)
    }

    fn shell(script: &str) -> Vec<String> {
        if cfg!(windows) {
            vec!["cmd".to_string(), "/C".to_string(), script.to_string()]
        } else {
            vec!["sh".to_string(), "-c".to_string(), script.to_string()]
        }
    }

    #[tokio::test]
    async fn gate_outcomes_capture_exit_and_tail() {
        let dir = tempfile::tempdir().unwrap();
        let repo = git_repo(dir.path());
        let passed = run_gate(
            &repo.root,
            &GateSpec {
                criterion: "unit".to_string(),
                command: shell("echo ok"),
                cwd: None,
                timeout_seconds: 30,
            },
        )
        .await
        .unwrap();
        assert_eq!(passed.status, "passed");
        assert_eq!(passed.exit_code, Some(0));
        assert!(passed.output_tail.contains("ok"));
        let failed = run_gate(
            &repo.root,
            &GateSpec {
                criterion: "unit".to_string(),
                command: shell("exit 3"),
                cwd: None,
                timeout_seconds: 30,
            },
        )
        .await
        .unwrap();
        assert_eq!(failed.status, "failed");
        assert_eq!(failed.exit_code, Some(3));
    }

    #[tokio::test]
    async fn gate_output_is_hashed_whole_and_reported_as_a_four_kilobyte_tail() {
        let dir = tempfile::tempdir().unwrap();
        let script = if cfg!(windows) {
            "echo START-OUTPUT&for /L %i in (1,1,600) do @echo 0123456789&echo END-OUTPUT"
        } else {
            "echo START-OUTPUT; i=0; while [ $i -lt 600 ]; do echo 0123456789; i=$((i+1)); done; echo END-OUTPUT"
        };
        let command = shell(script);
        let expected = std::process::Command::new(&command[0])
            .args(&command[1..])
            .output()
            .unwrap();
        let mut full = String::from_utf8_lossy(&expected.stdout).to_string();
        full.push_str(&String::from_utf8_lossy(&expected.stderr));
        let outcome = run_gate(
            dir.path(),
            &GateSpec {
                criterion: "big".to_string(),
                command,
                cwd: None,
                timeout_seconds: 30,
            },
        )
        .await
        .unwrap();
        assert_eq!(outcome.output_sha256, sha256_hex(full.as_bytes()));
        assert!(outcome.output_tail.len() <= OUTPUT_TAIL_BYTES + 4);
        assert!(outcome.output_tail.starts_with('…'));
        assert!(!outcome.output_tail.contains("START-OUTPUT"));
        assert!(outcome.output_tail.trim_end().ends_with("END-OUTPUT"));
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn gate_timeouts_are_reported() {
        let dir = tempfile::tempdir().unwrap();
        let outcome = run_gate(
            dir.path(),
            &GateSpec {
                criterion: "slow".to_string(),
                command: vec!["sh".to_string(), "-c".to_string(), "sleep 5".to_string()],
                cwd: None,
                timeout_seconds: 1,
            },
        )
        .await
        .unwrap();
        assert_eq!(outcome.status, "timeout");
    }

    #[tokio::test]
    async fn gate_cwd_cannot_escape_the_worktree() {
        let dir = tempfile::tempdir().unwrap();
        let error = run_gate(
            dir.path(),
            &GateSpec {
                criterion: "escape".to_string(),
                command: vec!["true".to_string()],
                cwd: Some("../".to_string()),
                timeout_seconds: 5,
            },
        )
        .await
        .unwrap_err();
        assert!(matches!(error, VerifyError::InvalidCwd(_)));
    }

    #[tokio::test]
    async fn claims_verify_file_line_symbol_and_commands() {
        let dir = tempfile::tempdir().unwrap();
        let repo = git_repo(dir.path());
        std::fs::write(
            repo.root.join("lib.ts"),
            "export function present() {}\nconst marker = 42;\n",
        )
        .unwrap();
        crate::git::tests_support::run(&repo.root, &["add", "."]);
        crate::git::tests_support::run(&repo.root, &["commit", "-q", "-m", "add lib"]);
        let line_claim = Claim {
            id: "c1".to_string(),
            probe: ClaimProbe::FileLine {
                path: "lib.ts".to_string(),
                line: 2,
                contains: Some("marker".to_string()),
            },
            blob_sha: None,
        };
        assert_eq!(
            verify_claim(&repo.root, &line_claim).await.unwrap().status,
            "fresh"
        );
        let symbol_claim = Claim {
            id: "c2".to_string(),
            probe: ClaimProbe::Symbol {
                path: "lib.ts".to_string(),
                symbol: "present".to_string(),
            },
            blob_sha: None,
        };
        assert_eq!(
            verify_claim(&repo.root, &symbol_claim)
                .await
                .unwrap()
                .status,
            "fresh"
        );
        let command_claim = Claim {
            id: "c3".to_string(),
            probe: ClaimProbe::Command {
                command: shell("exit 0"),
                cwd: None,
                timeout_seconds: Some(10),
            },
            blob_sha: None,
        };
        assert_eq!(
            verify_claim(&repo.root, &command_claim)
                .await
                .unwrap()
                .status,
            "fresh"
        );
        let stale = Claim {
            id: "c4".to_string(),
            probe: ClaimProbe::FileLine {
                path: "lib.ts".to_string(),
                line: 2,
                contains: Some("absent".to_string()),
            },
            blob_sha: None,
        };
        assert_eq!(
            verify_claim(&repo.root, &stale).await.unwrap().status,
            "stale"
        );
    }

    #[tokio::test]
    async fn changed_files_make_a_recorded_blob_sha_stale() {
        let dir = tempfile::tempdir().unwrap();
        let repo = git_repo(dir.path());
        std::fs::write(repo.root.join("a.txt"), "one\n").unwrap();
        let claim = Claim {
            id: "c1".to_string(),
            probe: ClaimProbe::FileLine {
                path: "a.txt".to_string(),
                line: 1,
                contains: None,
            },
            blob_sha: Some(git::blob_sha_at(&repo.root, "a.txt").unwrap()),
        };
        assert_eq!(
            verify_claim(&repo.root, &claim).await.unwrap().status,
            "fresh"
        );
        std::fs::write(repo.root.join("a.txt"), "two\n").unwrap();
        assert_eq!(
            verify_claim(&repo.root, &claim).await.unwrap().status,
            "stale"
        );
    }

    #[tokio::test]
    async fn gate_evidence_lands_under_the_job_directory() {
        let dir = tempfile::tempdir().unwrap();
        let outcome = run_gate(
            dir.path(),
            &GateSpec {
                criterion: "unit tests".to_string(),
                command: shell("echo hi"),
                cwd: None,
                timeout_seconds: 10,
            },
        )
        .await
        .unwrap();
        let evidence = evidence_dir(dir.path(), "job-1").unwrap();
        let path = record_gate(&evidence, &outcome).unwrap();
        assert!(path.starts_with(evidence_dir(dir.path(), "job-1").unwrap()));
        assert!(
            std::fs::read_to_string(path)
                .unwrap()
                .contains("\"status\": \"passed\"")
        );
    }
}
