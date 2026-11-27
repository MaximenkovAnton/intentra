use std::path::{Component, Path, PathBuf};

use sha2::{Digest, Sha256};
use time::OffsetDateTime;
use time::macros::format_description;

const ISO: &[time::format_description::FormatItem<'static>] =
    format_description!("[year]-[month]-[day]T[hour]:[minute]:[second].[subsecond digits:3]Z");

pub fn now_iso() -> String {
    OffsetDateTime::now_utc()
        .format(ISO)
        .unwrap_or_else(|_| "1970-01-01T00:00:00.000Z".to_string())
}

pub fn now_utc() -> OffsetDateTime {
    OffsetDateTime::now_utc()
}

pub fn parse_iso(value: &str) -> Option<OffsetDateTime> {
    OffsetDateTime::parse(value, &time::format_description::well_known::Rfc3339).ok()
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

pub fn tail(value: &str, max_bytes: usize) -> String {
    if value.len() <= max_bytes {
        return value.to_string();
    }
    let mut start = value.len() - max_bytes;
    while start < value.len() && !value.is_char_boundary(start) {
        start += 1;
    }
    format!("…{}", &value[start..])
}

pub fn expand_tilde(path: &str) -> PathBuf {
    if path == "~" {
        return home_dir();
    }
    match path.strip_prefix("~/") {
        Some(rest) => home_dir().join(rest),
        None => PathBuf::from(path),
    }
}

pub fn home_dir() -> PathBuf {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

pub fn random_token() -> String {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).expect("operating system randomness");
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

pub fn validate_job_id(job_id: &str) -> bool {
    !job_id.is_empty()
        && job_id.len() <= 64
        && job_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-')
}

pub fn slug(value: &str) -> String {
    let mut out = String::new();
    for c in value.chars().flat_map(char::to_lowercase) {
        if c.is_ascii_alphanumeric() {
            out.push(c);
        } else if !out.ends_with('-') {
            out.push('-');
        }
    }
    out.trim_matches('-').chars().take(48).collect()
}

/// Git for Windows rejects the extended-length `\\?\` prefix that
/// `canonicalize` adds, so strip it from paths that end up in git arguments.
pub fn strip_verbatim(path: PathBuf) -> PathBuf {
    #[cfg(windows)]
    {
        let text = path.to_string_lossy().into_owned();
        if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
            return PathBuf::from(format!(r"\\{rest}"));
        }
        if let Some(rest) = text.strip_prefix(r"\\?\") {
            return PathBuf::from(rest);
        }
    }
    path
}

pub fn canonical_dir(path: &Path) -> std::io::Result<PathBuf> {
    let canonical = path.canonicalize()?;
    if !canonical.is_dir() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::NotADirectory,
            format!("{} is not a directory", path.display()),
        ));
    }
    Ok(strip_verbatim(canonical))
}

pub fn resolve_inside(root: &Path, relative: &str) -> std::io::Result<PathBuf> {
    let candidate = Path::new(relative);
    if candidate
        .components()
        .any(|component| matches!(component, Component::ParentDir))
    {
        return Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "path escapes the worktree",
        ));
    }
    let joined = if candidate.is_absolute() {
        candidate.to_path_buf()
    } else {
        root.join(candidate)
    };
    let canonical_root = root.canonicalize()?;
    let resolved = match joined.canonicalize() {
        Ok(path) => path,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let parent = joined
                .parent()
                .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidInput, "no parent"))?
                .canonicalize()?;
            parent.join(
                joined.file_name().ok_or_else(|| {
                    std::io::Error::new(std::io::ErrorKind::InvalidInput, "no name")
                })?,
            )
        }
        Err(error) => return Err(error),
    };
    if resolved.starts_with(&canonical_root) {
        Ok(strip_verbatim(resolved))
    } else {
        Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            format!(
                "{} escapes {}",
                resolved.display(),
                canonical_root.display()
            ),
        ))
    }
}

pub fn inside_roots(path: &Path, roots: &[PathBuf]) -> bool {
    let Ok(resolved) = path.canonicalize() else {
        return false;
    };
    roots.iter().any(|root| {
        root.canonicalize()
            .map(|canonical| resolved.starts_with(canonical))
            .unwrap_or(false)
    })
}

pub fn is_valid_ws_url(url: &str) -> bool {
    url.starts_with("ws://") || url.starts_with("wss://")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tail_keeps_the_end_within_the_byte_budget() {
        let text = "a".repeat(5000);
        let cut = tail(&text, 4096);
        assert!(cut.len() <= 4096 + 4);
        assert!(cut.starts_with('…'));
        assert!(tail("short", 16).eq("short"));
    }

    #[test]
    fn sha256_hex_matches_the_known_vector() {
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn slug_is_safe_for_branch_names() {
        assert_eq!(slug("Intent: Add Runner!"), "intent-add-runner");
        assert_eq!(slug("  x  "), "x");
    }

    #[test]
    fn job_ids_with_path_separators_are_rejected() {
        assert!(validate_job_id("job-1"));
        assert!(!validate_job_id("../escape"));
        assert!(!validate_job_id(""));
    }
}
