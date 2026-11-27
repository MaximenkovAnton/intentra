use std::collections::BTreeMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Command;

use crate::protocol::{DiffSummary, JobDiffEntry};
use crate::util::{inside_roots, sha256_hex, strip_verbatim, tail, validate_job_id};

pub const INTENTRA_DIR: &str = ".intentra";

#[derive(Debug, thiserror::Error)]
pub enum GitError {
    #[error("git {args} failed in {cwd}: {message}")]
    Command {
        cwd: PathBuf,
        args: String,
        message: String,
    },
    #[error("cannot run git: {0}")]
    Spawn(#[source] std::io::Error),
    #[error("{0} is not inside a git repository")]
    NotARepository(PathBuf),
    #[error("{0} is outside the allowlist roots")]
    OutsideAllowlist(PathBuf),
    #[error("worktree is dirty: {0}")]
    Dirty(String),
    #[error("branch {0} already exists")]
    BranchExists(String),
    #[error("invalid job id for a worktree path: {0}")]
    InvalidJobId(String),
    #[error("{0} is not a commit in this repository")]
    InvalidBase(String),
    #[error("filesystem error at {path}: {source}")]
    Io {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
}

#[derive(Debug, Clone)]
struct Output {
    code: Option<i32>,
    stdout: String,
    stderr: String,
}

fn git(cwd: &Path, args: &[&str]) -> Result<Output, GitError> {
    let output = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("LC_ALL", "C")
        .output()
        .map_err(GitError::Spawn)?;
    Ok(Output {
        code: output.status.code(),
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
    })
}

fn git_ok(cwd: &Path, args: &[&str]) -> Result<String, GitError> {
    let output = git(cwd, args)?;
    if output.code != Some(0) {
        return Err(GitError::Command {
            cwd: cwd.to_path_buf(),
            args: args.join(" "),
            message: tail(output.stderr.trim(), 512),
        });
    }
    Ok(output.stdout)
}

fn git_succeeds(cwd: &Path, args: &[&str]) -> Result<bool, GitError> {
    Ok(git(cwd, args)?.code == Some(0))
}

#[derive(Debug, Clone)]
pub struct Repo {
    pub root: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Worktree {
    pub path: PathBuf,
    pub branch: String,
    pub base: String,
}

impl Repo {
    pub fn open(path: &Path, roots: &[PathBuf]) -> Result<Repo, GitError> {
        let canonical = strip_verbatim(path.canonicalize().map_err(|source| GitError::Io {
            path: path.to_path_buf(),
            source,
        })?);
        if !inside_roots(&canonical, roots) {
            return Err(GitError::OutsideAllowlist(canonical));
        }
        let output = git(&canonical, &["rev-parse", "--show-toplevel"])?;
        if output.code != Some(0) {
            return Err(GitError::NotARepository(canonical));
        }
        let root = PathBuf::from(output.stdout.trim());
        let root = strip_verbatim(root.canonicalize().map_err(|source| GitError::Io {
            path: root.clone(),
            source,
        })?);
        if !inside_roots(&root, roots) {
            return Err(GitError::OutsideAllowlist(root));
        }
        exclude_intentra(&root)?;
        Ok(Repo { root })
    }

    fn head(&self) -> Result<String, GitError> {
        Ok(git_ok(&self.root, &["rev-parse", "HEAD"])?
            .trim()
            .to_string())
    }

    pub fn ensure_clean(&self) -> Result<(), GitError> {
        let entries = status_entries(&self.root)?;
        if entries.is_empty() {
            return Ok(());
        }
        Err(GitError::Dirty(tail(&entries.join("\n"), 512)))
    }

    pub fn worktree_add(
        &self,
        job_id: &str,
        intent_short: &str,
        task: &str,
    ) -> Result<Worktree, GitError> {
        if !validate_job_id(job_id) {
            return Err(GitError::InvalidJobId(job_id.to_string()));
        }
        self.ensure_clean()?;
        let branch = format!(
            "intentra/{}-{}",
            crate::util::slug(intent_short),
            crate::util::slug(task)
        );
        let branch_exists = git_succeeds(
            &self.root,
            &[
                "show-ref",
                "--verify",
                "--quiet",
                &format!("refs/heads/{branch}"),
            ],
        )?;
        let base = self.head()?;
        let worktrees = self.root.join(INTENTRA_DIR).join("worktrees");
        std::fs::create_dir_all(&worktrees).map_err(|source| GitError::Io {
            path: worktrees.clone(),
            source,
        })?;
        let path = worktrees.join(job_id);
        let path_text = path.to_string_lossy().to_string();
        let result = if branch_exists {
            git_ok(
                &self.root,
                &["worktree", "add", "--force", &path_text, &branch],
            )
        } else {
            git_ok(
                &self.root,
                &["worktree", "add", "-b", &branch, &path_text, "HEAD"],
            )
        };
        if let Err(error) = result {
            let _ = git(&self.root, &["worktree", "prune"]);
            return Err(error);
        }
        Ok(Worktree { path, branch, base })
    }

    pub fn worktree_remove(&self, worktree: &Worktree) -> Result<(), GitError> {
        let path = worktree.path.to_string_lossy().to_string();
        if worktree.path.starts_with(&self.root) {
            let _ = git_ok(&self.root, &["worktree", "remove", "--force", &path]);
        }
        if worktree.path.exists() {
            std::fs::remove_dir_all(&worktree.path).map_err(|source| GitError::Io {
                path: worktree.path.clone(),
                source,
            })?;
        }
        let _ = git_ok(&self.root, &["worktree", "prune"]);
        Ok(())
    }
}

impl Worktree {
    pub fn commit_all(&self, task: &str) -> Result<Option<String>, GitError> {
        if status_entries(&self.path)?.is_empty() {
            return Ok(None);
        }
        git_ok(&self.path, &["add", "-A"])?;
        let message = format!("intentra: {}", task.lines().next().unwrap_or(task));
        git_ok(&self.path, &["commit", "-q", "-m", &message])?;
        Ok(Some(
            git_ok(&self.path, &["rev-parse", "HEAD"])?
                .trim()
                .to_string(),
        ))
    }

    fn has_origin(&self) -> Result<bool, GitError> {
        git_succeeds(&self.path, &["remote", "get-url", "origin"])
    }

    pub fn push(&self) -> Result<Option<String>, GitError> {
        if !self.has_origin()? {
            return Ok(None);
        }
        git_ok(&self.path, &["push", "-q", "-u", "origin", &self.branch])?;
        let remote = git_ok(&self.path, &["remote", "get-url", "origin"])?
            .trim()
            .to_string();
        Ok(pr_link(&remote, &self.branch))
    }

    pub fn diff_summary(&self, base: Option<&str>) -> Result<DiffSummary, GitError> {
        diff_summary_at(&self.path, base)
    }

    pub fn tree_hash(&self) -> Result<String, GitError> {
        tree_hash_at(&self.path)
    }
}

pub fn tree_hash_at(dir: &Path) -> Result<String, GitError> {
    let head = git_ok(dir, &["rev-parse", "HEAD"])?.trim().to_string();
    let status: Vec<String> = status_entries(dir)?
        .into_iter()
        .filter(|line| !line.contains(&format!("{INTENTRA_DIR}/")))
        .collect();
    Ok(sha256_hex(
        format!("{head}\n{}", status.join("\n")).as_bytes(),
    ))
}

pub fn blob_sha_at(dir: &Path, relative: &str) -> Result<String, GitError> {
    let resolved = crate::util::resolve_inside(dir, relative).map_err(|source| GitError::Io {
        path: dir.join(relative),
        source,
    })?;
    Ok(
        git_ok(dir, &["hash-object", "--", &resolved.to_string_lossy()])?
            .trim()
            .to_string(),
    )
}

fn resolve_base(dir: &Path, base: &str) -> Result<String, GitError> {
    let output = git(
        dir,
        &[
            "rev-parse",
            "--verify",
            "--quiet",
            "--end-of-options",
            &format!("{base}^{{commit}}"),
        ],
    )?;
    if output.code != Some(0) {
        return Err(GitError::InvalidBase(base.to_string()));
    }
    Ok(output.stdout.trim().to_string())
}

pub fn diff_summary_at(dir: &Path, base: Option<&str>) -> Result<DiffSummary, GitError> {
    let base = resolve_base(dir, base.unwrap_or("HEAD"))?;
    let mut entries: BTreeMap<String, JobDiffEntry> = BTreeMap::new();
    let numstat = git_ok(dir, &["diff", "--numstat", &base, "--"])?;
    let mut counts: BTreeMap<String, (u64, u64, bool)> = BTreeMap::new();
    for line in numstat.lines() {
        let parts: Vec<&str> = line.split('\t').collect();
        if parts.len() < 3 {
            continue;
        }
        let additions = parts[0].parse::<u64>().unwrap_or(0);
        let deletions = parts[1].parse::<u64>().unwrap_or(0);
        let binary = parts[0] == "-" || parts[1] == "-";
        let target = rename_target(parts[2]);
        if is_intentra_path(&target) {
            continue;
        }
        counts.insert(target, (additions, deletions, binary));
    }
    let name_status = git_ok(dir, &["diff", "--name-status", &base, "--"])?;
    for line in name_status.lines() {
        let parts: Vec<&str> = line.split('\t').collect();
        if parts.len() < 2 {
            continue;
        }
        let status = status_name(parts[0]);
        let path = if parts.len() >= 3 {
            parts[2].to_string()
        } else {
            parts[1].to_string()
        };
        if is_intentra_path(&path) {
            continue;
        }
        let (additions, deletions, binary) = counts.get(&path).copied().unwrap_or((0, 0, false));
        entries.insert(
            path.clone(),
            JobDiffEntry {
                path,
                status: status.to_string(),
                additions,
                deletions,
                binary,
            },
        );
    }
    let untracked = git_ok(dir, &["ls-files", "--others", "--exclude-standard", "--"])?;
    for line in untracked.lines() {
        if line.trim().is_empty() || is_intentra_path(line) {
            continue;
        }
        let (additions, binary) = untracked_stats(dir, line);
        entries.insert(
            line.to_string(),
            JobDiffEntry {
                path: line.to_string(),
                status: "added".to_string(),
                additions,
                deletions: 0,
                binary,
            },
        );
    }
    let entries: Vec<JobDiffEntry> = entries.into_values().collect();
    Ok(DiffSummary {
        files: entries.len() as u64,
        additions: entries.iter().map(|entry| entry.additions).sum(),
        deletions: entries.iter().map(|entry| entry.deletions).sum(),
        entries,
    })
}

pub fn exclude_intentra(dir: &Path) -> Result<(), GitError> {
    let common = git_ok(dir, &["rev-parse", "--git-common-dir"])?;
    let exclude = dir.join(common.trim()).join("info").join("exclude");
    if let Some(parent) = exclude.parent() {
        std::fs::create_dir_all(parent).map_err(|source| GitError::Io {
            path: parent.to_path_buf(),
            source,
        })?;
    }
    let existing = std::fs::read_to_string(&exclude).unwrap_or_default();
    if existing.lines().any(|line| line.trim() == ".intentra/") {
        return Ok(());
    }
    let mut body = existing;
    if !body.ends_with('\n') && !body.is_empty() {
        body.push('\n');
    }
    body.push_str(".intentra/\n");
    std::fs::write(&exclude, body).map_err(|source| GitError::Io {
        path: exclude.clone(),
        source,
    })?;
    Ok(())
}

fn status_entries(dir: &Path) -> Result<Vec<String>, GitError> {
    let output = git_ok(dir, &["--no-optional-locks", "status", "--porcelain"])?;
    Ok(output
        .lines()
        .map(str::trim_end)
        .filter(|line| !line.is_empty())
        .filter(|line| !line.contains(&format!("{INTENTRA_DIR}/")))
        .map(str::to_string)
        .collect())
}

const MAX_UNTRACKED_BYTES: u64 = 1 << 20;

// shortcut: untracked files over 1 MiB are reported as binary with no line count;
// stream-count them if a project ever needs exact additions that large.
fn untracked_stats(root: &Path, relative: &str) -> (u64, bool) {
    let Ok(path) = crate::util::resolve_inside(root, relative) else {
        return (0, true);
    };
    let Ok(metadata) = std::fs::symlink_metadata(&path) else {
        return (0, true);
    };
    if !metadata.file_type().is_file() || metadata.len() > MAX_UNTRACKED_BYTES {
        return (0, true);
    }
    let Ok(file) = std::fs::File::open(&path) else {
        return (0, false);
    };
    let mut bytes = Vec::new();
    if file
        .take(MAX_UNTRACKED_BYTES)
        .read_to_end(&mut bytes)
        .is_err()
    {
        return (0, false);
    }
    if bytes.contains(&0) {
        return (0, true);
    }
    let lines = if bytes.is_empty() {
        0
    } else {
        bytes.iter().filter(|byte| **byte == b'\n').count() as u64
            + u64::from(*bytes.last().unwrap_or(&b'\n') != b'\n')
    };
    (lines, false)
}

fn status_name(code: &str) -> &'static str {
    match code.chars().next() {
        Some('A') => "added",
        Some('D') => "deleted",
        Some('R') => "renamed",
        Some('C') => "copied",
        Some('T') => "type-changed",
        Some('U') => "unmerged",
        _ => "modified",
    }
}

fn rename_target(path: &str) -> String {
    if let Some(open) = path.find('{')
        && let Some(close) = path[open..].find('}')
    {
        let close = open + close;
        let inside = &path[open + 1..close];
        if let Some((_, target)) = inside.split_once(" => ") {
            return format!("{}{}{}", &path[..open], target.trim(), &path[close + 1..]);
        }
    }
    if let Some((_, target)) = path.split_once(" => ") {
        return target.trim().to_string();
    }
    path.to_string()
}

fn is_intentra_path(path: &str) -> bool {
    path == INTENTRA_DIR || path.starts_with(&format!("{INTENTRA_DIR}/"))
}

fn pr_link(remote: &str, branch: &str) -> Option<String> {
    let repo = remote
        .trim()
        .strip_prefix("git@github.com:")
        .or_else(|| remote.trim().strip_prefix("ssh://git@github.com/"))
        .or_else(|| remote.trim().strip_prefix("https://github.com/"))
        .map(|path| path.trim_end_matches(".git"));
    repo.map(|repo| format!("https://github.com/{repo}/compare/{branch}?expand=1"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn init_repo(dir: &Path) -> Repo {
        git_ok(dir, &["init", "-q", "-b", "main"]).unwrap();
        git_ok(dir, &["config", "user.email", "runner@example.test"]).unwrap();
        git_ok(dir, &["config", "user.name", "Intentra Runner"]).unwrap();
        std::fs::write(dir.join("README.md"), "hello\n").unwrap();
        git_ok(dir, &["add", "."]).unwrap();
        git_ok(dir, &["commit", "-q", "-m", "initial"]).unwrap();
        Repo {
            root: strip_verbatim(dir.canonicalize().unwrap()),
        }
    }

    #[test]
    fn worktree_lifecycle_commit_diff_and_tree_hash() {
        let dir = tempfile::tempdir().unwrap();
        let repo = init_repo(dir.path());
        let roots = vec![dir.path().to_path_buf()];
        let repo = Repo::open(&repo.root, &roots).unwrap();
        repo.ensure_clean().unwrap();
        let worktree = repo
            .worktree_add("job-1", "intent-one", "add-thing")
            .unwrap();
        assert_eq!(worktree.branch, "intentra/intent-one-add-thing");
        assert!(worktree.path.is_dir());
        let clean_hash = worktree.tree_hash().unwrap();
        std::fs::write(worktree.path.join("new.txt"), "one\ntwo\n").unwrap();
        let summary = worktree.diff_summary(Some(&worktree.base)).unwrap();
        assert_eq!(summary.files, 1);
        assert_eq!(summary.entries[0].path, "new.txt");
        assert_eq!(summary.entries[0].status, "added");
        assert_eq!(summary.entries[0].additions, 2);
        let committed = worktree.commit_all("add thing").unwrap().unwrap();
        assert_eq!(
            git_ok(&worktree.path, &["rev-parse", "HEAD"])
                .unwrap()
                .trim(),
            committed
        );
        assert_ne!(clean_hash, worktree.tree_hash().unwrap());
        let after = worktree.diff_summary(Some(&worktree.base)).unwrap();
        assert_eq!(after.files, 1);
        repo.worktree_remove(&worktree).unwrap();
        assert!(!worktree.path.exists());
    }

    #[test]
    fn a_dirty_worktree_is_reported_before_a_new_job() {
        let dir = tempfile::tempdir().unwrap();
        let repo = init_repo(dir.path());
        std::fs::write(dir.path().join("README.md"), "changed\n").unwrap();
        assert!(matches!(repo.ensure_clean(), Err(GitError::Dirty(_))));
    }

    #[test]
    fn repositories_outside_the_allowlist_are_refused() {
        let dir = tempfile::tempdir().unwrap();
        let other = tempfile::tempdir().unwrap();
        init_repo(dir.path());
        let error = Repo::open(dir.path(), &[other.path().to_path_buf()]).unwrap_err();
        assert!(matches!(error, GitError::OutsideAllowlist(_)));
    }

    #[test]
    fn push_creates_a_compare_link_when_origin_is_github() {
        assert_eq!(
            pr_link("git@github.com:intentra/runner.git", "intentra/x-y"),
            Some("https://github.com/intentra/runner/compare/intentra/x-y?expand=1".to_string())
        );
        assert_eq!(pr_link("https://example.test/repo.git", "b"), None);
    }

    #[test]
    fn rename_targets_keep_the_new_path() {
        assert_eq!(rename_target("src/{old => new}/file.rs"), "src/new/file.rs");
        assert_eq!(rename_target("src/old.rs => src/new.rs"), "src/new.rs");
        assert_eq!(rename_target("src/plain.rs"), "src/plain.rs");
    }

    #[test]
    fn diff_summary_refuses_an_option_shaped_base() {
        let dir = tempfile::tempdir().unwrap();
        let repo = init_repo(dir.path());
        let target = dir.path().join("overwritten");
        for base in ["--output=overwritten", "-p", "--stat"] {
            let error = diff_summary_at(&repo.root, Some(base)).unwrap_err();
            assert!(matches!(error, GitError::InvalidBase(_)), "{base}: {error}");
        }
        assert!(!target.exists());
    }

    #[cfg(unix)]
    #[test]
    fn untracked_entries_are_never_read_through_symlinks_or_special_files() {
        use std::os::unix::fs::symlink;

        let dir = tempfile::tempdir().unwrap();
        let repo = init_repo(dir.path());
        let outside = tempfile::tempdir().unwrap();
        let secret = outside.path().join("secret.txt");
        std::fs::write(&secret, "one\ntwo\nthree\n").unwrap();
        symlink(&secret, repo.root.join("link.txt")).unwrap();
        std::fs::write(repo.root.join("plain.txt"), "one\ntwo\n").unwrap();
        std::fs::write(repo.root.join("huge.txt"), "x\n".repeat(600_000)).unwrap();

        let summary = diff_summary_at(&repo.root, None).unwrap();
        let entry = |name: &str| {
            summary
                .entries
                .iter()
                .find(|entry| entry.path == name)
                .unwrap_or_else(|| panic!("missing {name}"))
        };
        let link = entry("link.txt");
        assert_eq!(link.additions, 0, "the symlink target was read");
        assert!(link.binary);
        assert_eq!(entry("plain.txt").additions, 2);
        assert!(!entry("plain.txt").binary);
        let huge = entry("huge.txt");
        assert_eq!(huge.additions, 0, "the huge untracked file was read");
        assert!(huge.binary);
    }

    #[cfg(unix)]
    #[test]
    fn an_untracked_fifo_does_not_block_the_diff_summary() {
        use std::os::unix::fs::symlink;

        let dir = tempfile::tempdir().unwrap();
        let repo = init_repo(dir.path());
        let fifo = repo.root.join("real-pipe");
        let status = std::process::Command::new("mkfifo")
            .arg(&fifo)
            .status()
            .unwrap();
        assert!(status.success());
        symlink(&fifo, repo.root.join("pipe")).unwrap();
        let (sender, receiver) = std::sync::mpsc::channel();
        let root = repo.root.clone();
        std::thread::spawn(move || {
            let _ = sender.send(diff_summary_at(&root, None).map(|summary| summary.entries));
        });
        let entries = receiver
            .recv_timeout(std::time::Duration::from_secs(10))
            .expect("diff summary waits on an untracked FIFO")
            .unwrap();
        assert!(entries.iter().any(|entry| entry.path == "pipe"));
    }
}

#[cfg(test)]
pub(crate) mod tests_support {
    use super::*;

    pub fn init_repo(dir: &Path) -> Repo {
        git_ok(dir, &["init", "-q", "-b", "main"]).unwrap();
        git_ok(dir, &["config", "user.email", "runner@example.test"]).unwrap();
        git_ok(dir, &["config", "user.name", "Intentra Runner"]).unwrap();
        std::fs::write(dir.join("README.md"), "hello\n").unwrap();
        git_ok(dir, &["add", "."]).unwrap();
        git_ok(dir, &["commit", "-q", "-m", "initial"]).unwrap();
        Repo {
            root: strip_verbatim(dir.canonicalize().unwrap()),
        }
    }

    pub fn run(dir: &Path, args: &[&str]) {
        git_ok(dir, args).unwrap();
    }
}
