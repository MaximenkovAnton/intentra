use std::path::{Path, PathBuf};

use crate::config::UpdateConfig;
use crate::protocol::PROTOCOL_VERSION;
use crate::update::client::{UpdateClient, UpdateReport, UpdateStatus};
use crate::update::manifest::{RunnerUpdate, Target, UpdateAsset, parse_manifest};
use crate::update::public_key;
use crate::update::signature::verify_manifest_with_key;
use crate::update::state::{PendingUpdate, UpdateState};
use crate::util::now_iso;

#[cfg(unix)]
pub const RUNNER_BINARY: &str = "intentra-runner";
#[cfg(windows)]
pub const RUNNER_BINARY: &str = "intentra-runner.exe";

pub const ARCHIVE_STAGING: &str = "update-archive.tmp";
pub const BINARY_STAGING: &str = "update-binary.tmp";

#[derive(Debug, thiserror::Error)]
pub enum ApplyError {
    #[error("the archive is not usable: {0}")]
    Archive(String),
    #[error("the runner binary could not be replaced: {0}")]
    Install(String),
    #[error("the runner could not be restarted: {0}")]
    Restart(String),
    #[error("self-check failed: {0}")]
    SelfCheck(String),
    #[error("no <exe>.prev backup exists")]
    NoBackup,
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

pub trait Installer: Send + Sync {
    fn backup(&self) -> Result<(), ApplyError>;
    fn install(&self, staged: &Path) -> Result<(), ApplyError>;
    fn rollback(&self) -> Result<(), ApplyError>;
}

/// `current_exe()` reads `/proc/self/exe`, which the kernel marks with a
/// ` (deleted)` suffix once `self-replace` has renamed the new binary over the
/// running one; the path without that suffix still names the new executable.
#[cfg(unix)]
fn without_deleted_suffix(exe: PathBuf) -> PathBuf {
    match exe.to_str() {
        Some(text) => match text.strip_suffix(" (deleted)") {
            Some(trimmed) => PathBuf::from(trimmed),
            None => exe,
        },
        None => exe,
    }
}

fn current_executable() -> Result<PathBuf, ApplyError> {
    let exe = std::env::current_exe()?;
    #[cfg(unix)]
    let exe = without_deleted_suffix(exe);
    let exe = exe.canonicalize().unwrap_or(exe);
    Ok(crate::util::strip_verbatim(exe))
}

/// `self-replace` resolves `current_exe()` again, which is already marked
/// ` (deleted)` after the first replace, so a rollback in the same process
/// cannot use it on unix; a temp file next to the executable is renamed over it.
#[cfg(unix)]
fn replace_file(exe: &Path, replacement: &Path) -> Result<(), ApplyError> {
    let parent = exe.parent().ok_or_else(|| {
        ApplyError::Install("the runner executable has no parent directory".to_string())
    })?;
    let name = exe
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("intentra-runner");
    let temp = parent.join(format!(".{name}.replace"));
    let permissions = std::fs::metadata(exe)?.permissions();
    std::fs::copy(replacement, &temp)?;
    std::fs::set_permissions(&temp, permissions)?;
    std::fs::rename(&temp, exe)?;
    Ok(())
}

pub struct SelfReplaceInstaller;

impl SelfReplaceInstaller {
    fn binary_path() -> Result<PathBuf, ApplyError> {
        current_executable()
    }

    fn backup_path(exe: &Path) -> PathBuf {
        let mut raw = exe.as_os_str().to_owned();
        raw.push(".prev");
        PathBuf::from(raw)
    }
}

impl Installer for SelfReplaceInstaller {
    fn backup(&self) -> Result<(), ApplyError> {
        let exe = SelfReplaceInstaller::binary_path()?;
        std::fs::copy(&exe, SelfReplaceInstaller::backup_path(&exe))?;
        Ok(())
    }

    #[cfg(unix)]
    fn install(&self, staged: &Path) -> Result<(), ApplyError> {
        replace_file(&SelfReplaceInstaller::binary_path()?, staged)
    }

    #[cfg(windows)]
    fn install(&self, staged: &Path) -> Result<(), ApplyError> {
        self_replace::self_replace(staged).map_err(|error| ApplyError::Install(error.to_string()))
    }

    fn rollback(&self) -> Result<(), ApplyError> {
        let exe = SelfReplaceInstaller::binary_path()?;
        let backup = SelfReplaceInstaller::backup_path(&exe);
        if !backup.is_file() {
            return Err(ApplyError::NoBackup);
        }
        #[cfg(unix)]
        {
            replace_file(&exe, &backup)
        }
        #[cfg(windows)]
        {
            self_replace::self_replace(&backup)
                .map_err(|error| ApplyError::Install(error.to_string()))
        }
    }
}

pub trait Restarter: Send + Sync {
    fn restart(&self) -> Result<(), ApplyError>;
}

pub struct ProcessRestarter {
    #[cfg(windows)]
    state_dir: PathBuf,
}

impl ProcessRestarter {
    pub fn new(_state_dir: PathBuf) -> ProcessRestarter {
        ProcessRestarter {
            #[cfg(windows)]
            state_dir: _state_dir,
        }
    }
}

#[cfg(unix)]
impl Restarter for ProcessRestarter {
    fn restart(&self) -> Result<(), ApplyError> {
        use std::os::unix::process::CommandExt;
        let exe = current_executable()?;
        let args: Vec<std::ffi::OsString> = std::env::args_os().skip(1).collect();
        let error = std::process::Command::new(exe).args(args).exec();
        Err(ApplyError::Restart(error.to_string()))
    }
}

#[cfg(windows)]
impl Restarter for ProcessRestarter {
    fn restart(&self) -> Result<(), ApplyError> {
        let exe = std::env::current_exe()?;
        let args: Vec<std::ffi::OsString> = std::env::args_os().skip(1).collect();
        let mut child = std::process::Command::new(exe)
            .args(args)
            .spawn()
            .map_err(|error| ApplyError::Restart(error.to_string()))?;
        let child_id = child.id();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        loop {
            if let Ok(state) = crate::state::RunnerState::read(&self.state_dir) {
                if state.pid == child_id {
                    std::process::exit(0);
                }
            }
            if let Ok(Some(status)) = child.try_wait() {
                return Err(ApplyError::Restart(format!(
                    "the new runner exited with {status}"
                )));
            }
            if std::time::Instant::now() >= deadline {
                let _ = child.kill();
                return Err(ApplyError::Restart(
                    "the new runner did not become ready within 10s".to_string(),
                ));
            }
            std::thread::sleep(std::time::Duration::from_millis(200));
        }
    }
}

pub fn self_check(config_path: &Path, token_path: &Path) -> Result<(), ApplyError> {
    crate::config::Config::load(config_path)
        .map_err(|error| ApplyError::SelfCheck(error.to_string()))?;
    crate::token::load(token_path).map_err(|error| ApplyError::SelfCheck(error.to_string()))?;
    let output = std::process::Command::new("git")
        .arg("--version")
        .output()
        .map_err(|error| ApplyError::SelfCheck(error.to_string()))?;
    if !output.status.success() {
        return Err(ApplyError::SelfCheck("the git CLI is required".to_string()));
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ApplyOutcome {
    Applied { version: String },
    Failed(UpdateReport),
    RolledBack(UpdateReport),
}

impl ApplyOutcome {
    pub fn report(&self) -> Option<&UpdateReport> {
        match self {
            ApplyOutcome::Applied { .. } => None,
            ApplyOutcome::Failed(report) | ApplyOutcome::RolledBack(report) => Some(report),
        }
    }
}

pub struct ApplyRequest<'a> {
    pub client: &'a UpdateClient,
    pub update: &'a UpdateConfig,
    pub current_version: &'a str,
    pub state_dir: &'a Path,
    pub installer: &'a dyn Installer,
    pub restarter: Option<&'a dyn Restarter>,
}

struct VerifiedRelease {
    version: String,
    asset: UpdateAsset,
}

pub async fn apply_release(request: &ApplyRequest<'_>, update: &RunnerUpdate) -> ApplyOutcome {
    let verified = match verify_update(request, update) {
        Ok(verified) => verified,
        Err(reason) => {
            return ApplyOutcome::Failed(UpdateReport::new(
                request.current_version,
                update
                    .latest_version
                    .clone()
                    .unwrap_or_else(|| request.current_version.to_string()),
                UpdateStatus::Failed,
                Some(reason),
            ));
        }
    };
    let archive = request.state_dir.join(ARCHIVE_STAGING);
    let outcome = match request.client.download(&verified.asset, &archive).await {
        Ok(()) => match std::fs::read(&archive) {
            Ok(bytes) => install_archive(request, &verified.version, &bytes),
            Err(error) => ApplyOutcome::Failed(UpdateReport::new(
                request.current_version,
                verified.version,
                UpdateStatus::Failed,
                Some(format!("cannot read the downloaded archive: {error}")),
            )),
        },
        Err(error) => ApplyOutcome::Failed(UpdateReport::new(
            request.current_version,
            verified.version,
            UpdateStatus::Failed,
            Some(error.to_string()),
        )),
    };
    cleanup_staging(request.state_dir);
    outcome
}

fn verify_update(
    request: &ApplyRequest<'_>,
    update: &RunnerUpdate,
) -> Result<VerifiedRelease, String> {
    if !update.available {
        return Err("the center reports no available update".to_string());
    }
    update.validate().map_err(|error| error.to_string())?;
    let manifest_bytes = update.manifest.as_deref().unwrap_or_default().as_bytes();
    let signature = update.signature.as_deref().unwrap_or_default();
    let key = public_key().map_err(|error| error.to_string())?;
    verify_manifest_with_key(manifest_bytes, signature, &key)
        .map_err(|error| format!("the update signature is not valid: {error}"))?;
    let manifest = parse_manifest(manifest_bytes).map_err(|error| error.to_string())?;
    if manifest.channel != request.update.channel {
        return Err(format!(
            "the update channel {} does not match the configured channel {}",
            manifest.channel.as_str(),
            request.update.channel.as_str()
        ));
    }
    if manifest.protocol_version != PROTOCOL_VERSION {
        return Err(format!(
            "the update protocolVersion {} does not match the runner protocol {PROTOCOL_VERSION}",
            manifest.protocol_version
        ));
    }
    if update.latest_version.as_deref() != Some(manifest.version.as_str()) {
        return Err(format!(
            "the update latestVersion {:?} does not match the manifest version {}",
            update.latest_version, manifest.version
        ));
    }
    let target = Target::current()
        .ok_or_else(|| "this platform is not one of the release targets".to_string())?;
    let asset = manifest
        .assets
        .into_iter()
        .find(|asset| asset.target == target)
        .ok_or_else(|| format!("the update manifest has no asset for {target:?}"))?;
    Ok(VerifiedRelease {
        version: manifest.version,
        asset,
    })
}

fn install_archive(request: &ApplyRequest<'_>, version: &str, archive: &[u8]) -> ApplyOutcome {
    let staged = request.state_dir.join(BINARY_STAGING);
    let outcome = install_from_archive(request, version, archive, &staged);
    let _ = std::fs::remove_file(&staged);
    outcome
}

fn install_from_archive(
    request: &ApplyRequest<'_>,
    version: &str,
    archive: &[u8],
    staged: &Path,
) -> ApplyOutcome {
    if let Err(error) = extract_runner(archive, staged) {
        return failed(request.current_version, version, error.to_string());
    }
    if let Err(error) = request.installer.backup() {
        return failed(
            request.current_version,
            version,
            format!("cannot back up the current binary: {error}"),
        );
    }
    let mut state = match UpdateState::load(request.state_dir) {
        Ok(state) => state.unwrap_or_default(),
        Err(error) => {
            tracing::warn!(error = %error, "ignoring an unreadable update state file");
            UpdateState::default()
        }
    };
    state.set_pending(PendingUpdate {
        from: request.current_version.to_string(),
        to: version.to_string(),
        attempts: 0,
        staged_at: now_iso(),
    });
    if let Err(error) = state.save(request.state_dir) {
        return failed(
            request.current_version,
            version,
            format!("cannot record the pending update: {error}"),
        );
    }
    if let Err(error) = request.installer.install(staged) {
        let _ = request.installer.rollback();
        state.clear_pending();
        if let Err(error) = state.save(request.state_dir) {
            tracing::warn!(error = %error, "cannot save the update state");
        }
        return failed(
            request.current_version,
            version,
            format!("cannot replace the runner binary: {error}"),
        );
    }
    if let Some(restarter) = request.restarter
        && let Err(error) = restarter.restart()
    {
        let _ = request.installer.rollback();
        state.clear_pending();
        if let Err(error) = state.save(request.state_dir) {
            tracing::warn!(error = %error, "cannot save the update state");
        }
        return ApplyOutcome::RolledBack(UpdateReport::new(
            request.current_version,
            version,
            UpdateStatus::RolledBack,
            Some(format!("the runner could not restart: {error}")),
        ));
    }
    ApplyOutcome::Applied {
        version: version.to_string(),
    }
}

fn failed(from: &str, to: &str, reason: String) -> ApplyOutcome {
    ApplyOutcome::Failed(UpdateReport::new(
        from,
        to,
        UpdateStatus::Failed,
        Some(reason),
    ))
}

fn cleanup_staging(state_dir: &Path) {
    let _ = std::fs::remove_file(state_dir.join(ARCHIVE_STAGING));
    let _ = std::fs::remove_file(state_dir.join(BINARY_STAGING));
}

pub fn extract_runner(archive: &[u8], staged: &Path) -> Result<(), ApplyError> {
    #[cfg(unix)]
    let binary = extract_tar_gz(archive)?;
    #[cfg(windows)]
    let binary = extract_zip(archive)?;
    write_staged(staged, &binary)
}

fn check_entry_path(path: &Path) -> Result<(), ApplyError> {
    use std::path::Component;
    let unsafe_entry = path.is_absolute()
        || path.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        });
    if unsafe_entry {
        return Err(ApplyError::Archive(format!(
            "unsafe archive entry {}",
            path.display()
        )));
    }
    Ok(())
}

fn is_runner_binary(path: &Path) -> bool {
    path.file_name()
        .map(|name| name == std::ffi::OsStr::new(RUNNER_BINARY))
        .unwrap_or(false)
}

#[cfg(unix)]
fn extract_tar_gz(archive: &[u8]) -> Result<Vec<u8>, ApplyError> {
    use std::io::Read;

    let decoder = flate2::read::GzDecoder::new(archive);
    let mut tar = tar::Archive::new(decoder);
    let entries = tar
        .entries()
        .map_err(|error| ApplyError::Archive(error.to_string()))?;
    let mut found: Option<Vec<u8>> = None;
    for entry in entries {
        let mut entry = entry.map_err(|error| ApplyError::Archive(error.to_string()))?;
        let path = entry
            .path()
            .map_err(|error| ApplyError::Archive(error.to_string()))?
            .into_owned();
        check_entry_path(&path)?;
        if is_runner_binary(&path) {
            if found.is_some() {
                return Err(ApplyError::Archive(
                    "the archive contains the runner binary twice".to_string(),
                ));
            }
            let mut bytes = Vec::new();
            entry
                .read_to_end(&mut bytes)
                .map_err(|error| ApplyError::Archive(error.to_string()))?;
            found = Some(bytes);
        }
    }
    found.ok_or_else(|| ApplyError::Archive(format!("the archive has no {RUNNER_BINARY} entry")))
}

#[cfg(windows)]
fn extract_zip(archive: &[u8]) -> Result<Vec<u8>, ApplyError> {
    use std::io::Read;

    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(archive))
        .map_err(|error| ApplyError::Archive(error.to_string()))?;
    let mut found: Option<Vec<u8>> = None;
    for index in 0..zip.len() {
        let mut entry = zip
            .by_index(index)
            .map_err(|error| ApplyError::Archive(error.to_string()))?;
        let name = entry.name().to_string();
        let path = Path::new(&name);
        check_entry_path(path)?;
        if entry.is_dir() || !is_runner_binary(path) {
            continue;
        }
        if found.is_some() {
            return Err(ApplyError::Archive(
                "the archive contains the runner binary twice".to_string(),
            ));
        }
        let mut bytes = Vec::new();
        entry
            .read_to_end(&mut bytes)
            .map_err(|error| ApplyError::Archive(error.to_string()))?;
        found = Some(bytes);
    }
    found.ok_or_else(|| ApplyError::Archive(format!("the archive has no {RUNNER_BINARY} entry")))
}

fn write_staged(staged: &Path, bytes: &[u8]) -> Result<(), ApplyError> {
    if let Some(parent) = staged.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(staged, bytes)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(staged, std::fs::Permissions::from_mode(0o755))?;
    }
    Ok(())
}

pub struct ReconcileRequest<'a> {
    pub state_dir: &'a Path,
    pub current_version: &'a str,
    pub config_path: &'a Path,
    pub token_path: &'a Path,
    pub installer: &'a dyn Installer,
    pub restarter: &'a dyn Restarter,
    pub client: Option<&'a UpdateClient>,
}

pub async fn reconcile_pending(request: &ReconcileRequest<'_>) -> Option<UpdateReport> {
    let mut state = match UpdateState::load(request.state_dir) {
        Ok(Some(state)) => state,
        Ok(None) => return None,
        Err(error) => {
            tracing::warn!(error = %error, "ignoring an unreadable update state file");
            return None;
        }
    };
    let pending = state.pending.clone()?;
    if pending.to != request.current_version {
        tracing::warn!(
            from = %pending.from,
            to = %pending.to,
            current = %request.current_version,
            "discarding a pending update for another version"
        );
        state.clear_pending();
        if let Err(error) = state.save(request.state_dir) {
            tracing::warn!(error = %error, "cannot save the update state");
        }
        return None;
    }
    if state.attempts() == 0 {
        state.set_pending(PendingUpdate {
            attempts: 1,
            ..pending.clone()
        });
        if let Err(error) = state.save(request.state_dir) {
            tracing::warn!(error = %error, "cannot record the update attempt");
        }
        match self_check(request.config_path, request.token_path) {
            Ok(()) => {
                tracing::info!(version = %pending.to, "the updated runner passed its self-check");
                return None;
            }
            Err(error) => {
                tracing::warn!(error = %error, "the updated runner failed its self-check; rolling back");
                return roll_back(request, &mut state, &pending, error.to_string()).await;
            }
        }
    }
    tracing::warn!(version = %pending.to, "the update was not confirmed; rolling back");
    roll_back(
        request,
        &mut state,
        &pending,
        "the updated runner did not confirm the update".to_string(),
    )
    .await
}

async fn roll_back(
    request: &ReconcileRequest<'_>,
    state: &mut UpdateState,
    pending: &PendingUpdate,
    reason: String,
) -> Option<UpdateReport> {
    if let Err(error) = request.installer.rollback() {
        tracing::error!(error = %error, "cannot restore the previous runner binary");
        let report = UpdateReport::new(
            pending.from.clone(),
            pending.to.clone(),
            UpdateStatus::Failed,
            Some(format!(
                "{reason}; the previous binary could not be restored: {error}"
            )),
        );
        report_outcome(request.client, Some(&report)).await;
        return Some(report);
    }
    state.clear_pending();
    if let Err(error) = state.save(request.state_dir) {
        tracing::warn!(error = %error, "cannot save the update state");
    }
    let report = UpdateReport::new(
        pending.from.clone(),
        pending.to.clone(),
        UpdateStatus::RolledBack,
        Some(reason),
    );
    report_outcome(request.client, Some(&report)).await;
    if let Err(error) = request.restarter.restart() {
        tracing::error!(error = %error, "cannot restart the previous runner");
    }
    Some(report)
}

pub async fn report_outcome(client: Option<&UpdateClient>, report: Option<&UpdateReport>) {
    let (Some(client), Some(report)) = (client, report) else {
        return;
    };
    if let Err(error) = client.report(report).await {
        tracing::warn!(error = %error, "could not report the update outcome to the center");
    }
}

#[cfg(test)]
pub(crate) mod test_support {
    use std::path::Path;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

    use super::{ApplyError, Installer, Restarter};

    #[derive(Default)]
    pub struct FakeInstaller {
        pub calls: AtomicUsize,
        pub backups: AtomicUsize,
        pub fail_install: AtomicBool,
        probe: std::sync::Mutex<Option<Box<dyn Fn() + Send + Sync>>>,
    }

    impl FakeInstaller {
        pub fn calls(&self) -> usize {
            self.calls.load(Ordering::SeqCst)
        }

        pub fn backups(&self) -> usize {
            self.backups.load(Ordering::SeqCst)
        }

        pub fn fail_install(&self) {
            self.fail_install.store(true, Ordering::SeqCst);
        }

        pub fn probe(&self, probe: Box<dyn Fn() + Send + Sync>) {
            *self.probe.lock().unwrap() = Some(probe);
        }
    }

    impl Installer for FakeInstaller {
        fn backup(&self) -> Result<(), ApplyError> {
            self.backups.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }

        fn install(&self, _staged: &Path) -> Result<(), ApplyError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            if self.fail_install.load(Ordering::SeqCst) {
                return Err(ApplyError::Install("injected install failure".to_string()));
            }
            if let Some(probe) = self.probe.lock().unwrap().as_ref() {
                probe();
            }
            Ok(())
        }

        fn rollback(&self) -> Result<(), ApplyError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }
    }

    #[derive(Default)]
    pub struct FakeRestarter {
        calls: AtomicUsize,
        fail_first: AtomicBool,
        probe: std::sync::Mutex<Option<Box<dyn Fn() + Send + Sync>>>,
    }

    impl FakeRestarter {
        pub fn calls(&self) -> usize {
            self.calls.load(Ordering::SeqCst)
        }

        pub fn fail_first(&self) {
            self.fail_first.store(true, Ordering::SeqCst);
        }

        pub fn probe(&self, probe: Box<dyn Fn() + Send + Sync>) {
            *self.probe.lock().unwrap() = Some(probe);
        }
    }

    impl Restarter for FakeRestarter {
        fn restart(&self) -> Result<(), ApplyError> {
            let call = self.calls.fetch_add(1, Ordering::SeqCst);
            if call == 0 && self.fail_first.load(Ordering::SeqCst) {
                return Err(ApplyError::Restart("injected restart failure".to_string()));
            }
            if let Some(probe) = self.probe.lock().unwrap().as_ref() {
                probe();
            }
            Ok(())
        }
    }

    #[cfg(unix)]
    fn tar_bytes(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let mut builder = tar::Builder::new(Vec::new());
        for (name, bytes) in entries {
            let mut header = tar::Header::new_gnu();
            header.set_size(bytes.len() as u64);
            header.set_mode(0o755);
            header.set_cksum();
            builder
                .append_data(&mut header, *name, std::io::Cursor::new(*bytes))
                .unwrap();
        }
        builder.into_inner().unwrap()
    }

    #[cfg(unix)]
    fn gzip(bytes: &[u8]) -> Vec<u8> {
        use flate2::Compression;
        use flate2::write::GzEncoder;

        let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
        std::io::Write::write_all(&mut encoder, bytes).unwrap();
        encoder.finish().unwrap()
    }

    #[cfg(unix)]
    pub fn archive(entries: &[(&str, &[u8])]) -> Vec<u8> {
        gzip(&tar_bytes(entries))
    }

    #[cfg(unix)]
    pub fn archive_with_entry_name(entries: &[(&str, &[u8])], from: &str, to: &str) -> Vec<u8> {
        assert_eq!(from.len(), to.len());
        let mut tar = tar_bytes(entries);
        let found = tar
            .windows(from.len())
            .position(|window| window == from.as_bytes())
            .expect("the temporary entry name exists");
        let block = found & !511;
        tar[found..found + from.len()].copy_from_slice(to.as_bytes());
        tar[block + 148..block + 156].copy_from_slice(b"        ");
        let sum: u32 = tar[block..block + 512]
            .iter()
            .map(|byte| u32::from(*byte))
            .sum();
        tar[block + 148..block + 156].copy_from_slice(format!("{sum:06o}\0 ").as_bytes());
        gzip(&tar)
    }

    #[cfg(windows)]
    pub fn archive(entries: &[(&str, &[u8])]) -> Vec<u8> {
        use std::io::Write;

        let mut writer = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        for (name, bytes) in entries {
            writer
                .start_file(*name, zip::write::SimpleFileOptions::default())
                .unwrap();
            writer.write_all(bytes).unwrap();
        }
        writer.finish().unwrap().into_inner()
    }

    pub struct ReleaseSpec {
        pub version: String,
        pub channel: String,
        pub protocol: u32,
        pub latest: String,
        pub sha256: String,
    }

    impl ReleaseSpec {
        pub fn for_archive(version: &str, archive: &[u8]) -> ReleaseSpec {
            ReleaseSpec {
                version: version.to_string(),
                channel: "stable".to_string(),
                protocol: 1,
                latest: version.to_string(),
                sha256: crate::util::sha256_hex(archive),
            }
        }
    }

    pub fn signed_update(spec: &ReleaseSpec, archive: &[u8]) -> serde_json::Value {
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
                serde_json::json!({
                    "target": target,
                    "fileName": format!("intentra-runner-{}-{target}.tar.gz", spec.version),
                    "url": format!("https://example.test/{target}.tar.gz"),
                    "sizeBytes": archive.len(),
                    "sha256": spec.sha256,
                })
            })
            .collect();
        let manifest = serde_json::json!({
            "schemaVersion": 1,
            "version": spec.version,
            "channel": spec.channel,
            "protocolVersion": spec.protocol,
            "publishedAt": "2026-11-27T18:00:00Z",
            "notes": "test release",
            "assets": assets,
        });
        let manifest_bytes = serde_json::to_vec(&manifest).unwrap();
        serde_json::json!({
            "available": true,
            "channel": spec.channel,
            "latestVersion": spec.latest,
            "pinnedVersion": null,
            "autoUpdate": true,
            "manifest": String::from_utf8(manifest_bytes.clone()).unwrap(),
            "signature": crate::update::fixtures::sign(&manifest_bytes),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::{FakeInstaller, FakeRestarter};
    use super::*;

    #[cfg(unix)]
    const ARCHIVE_BINARY: &str = "intentra-runner";
    #[cfg(windows)]
    const ARCHIVE_BINARY: &str = "intentra-runner.exe";

    const BINARY_BYTES: &[u8] = b"#!/bin/sh\necho 0.2.0\n";

    #[cfg(unix)]
    #[test]
    fn the_installer_replaces_the_running_file_through_a_temp_file() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let exe = dir.path().join("intentra-runner");
        let replacement = dir.path().join("replacement");
        std::fs::write(&exe, b"old").unwrap();
        std::fs::set_permissions(&exe, std::fs::Permissions::from_mode(0o755)).unwrap();
        std::fs::write(&replacement, b"new").unwrap();
        replace_file(&exe, &replacement).unwrap();
        assert_eq!(std::fs::read(&exe).unwrap(), b"new");
        assert_eq!(
            std::fs::metadata(&exe).unwrap().permissions().mode() & 0o777,
            0o755
        );
        assert!(!dir.path().join(".intentra-runner.replace").exists());
    }

    #[cfg(unix)]
    #[test]
    fn the_executable_path_drops_the_deleted_suffix_after_a_replace() {
        assert_eq!(
            without_deleted_suffix(PathBuf::from("/opt/intentra-runner (deleted)")),
            PathBuf::from("/opt/intentra-runner")
        );
        assert_eq!(
            without_deleted_suffix(PathBuf::from("/opt/intentra-runner")),
            PathBuf::from("/opt/intentra-runner")
        );
        assert_eq!(
            without_deleted_suffix(PathBuf::from("/opt/runner (deleted) copy")),
            PathBuf::from("/opt/runner (deleted) copy")
        );
    }

    #[test]
    fn extracts_the_runner_binary() {
        let dir = tempfile::tempdir().unwrap();
        let staged = dir.path().join(ARCHIVE_BINARY);
        let bytes = super::test_support::archive(&[
            ("LICENSE", b"MIT\n"),
            (ARCHIVE_BINARY, BINARY_BYTES),
            ("notes/README.md", b"docs\n"),
        ]);
        extract_runner(&bytes, &staged).unwrap();
        assert_eq!(std::fs::read(&staged).unwrap(), BINARY_BYTES);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&staged).unwrap().permissions().mode() & 0o777,
                0o755
            );
        }
    }

    fn install_archive_for_test(
        state_dir: &Path,
        archive: &[u8],
        installer: &FakeInstaller,
        restarter: &FakeRestarter,
    ) -> ApplyOutcome {
        let client = UpdateClient::new("wss://intentra.example", "token", false).unwrap();
        let update = crate::config::UpdateConfig {
            enabled: true,
            channel: crate::config::Channel::Stable,
            check_interval_min: 5,
            allow_insecure_http: false,
        };
        let request = ApplyRequest {
            client: &client,
            update: &update,
            current_version: "0.1.0",
            state_dir,
            installer,
            restarter: Some(restarter),
        };
        install_archive(&request, "0.2.0", archive)
    }

    #[test]
    fn rejects_unsafe_or_incomplete_archives() {
        let mut cases: Vec<(&str, Vec<u8>)> = vec![(
            "incomplete",
            super::test_support::archive(&[("LICENSE", b"MIT\n")]),
        )];
        #[cfg(unix)]
        {
            cases.push((
                "parent directory",
                super::test_support::archive_with_entry_name(
                    &[("zq", b"x"), (ARCHIVE_BINARY, BINARY_BYTES)],
                    "zq",
                    "..",
                ),
            ));
            cases.push((
                "absolute path",
                super::test_support::archive_with_entry_name(
                    &[("root/passwd", b"root\n"), (ARCHIVE_BINARY, BINARY_BYTES)],
                    "root/passwd",
                    "/etc/passwd",
                ),
            ));
            cases.push((
                "parent inside a name",
                super::test_support::archive_with_entry_name(
                    &[("ab/evil", b"x"), (ARCHIVE_BINARY, BINARY_BYTES)],
                    "ab/evil",
                    "../evil",
                ),
            ));
        }
        #[cfg(windows)]
        {
            cases.push((
                "parent directory",
                super::test_support::archive(&[("..", b"x"), (ARCHIVE_BINARY, BINARY_BYTES)]),
            ));
            cases.push((
                "absolute path",
                super::test_support::archive(&[
                    ("/etc/passwd", b"root\n"),
                    (ARCHIVE_BINARY, BINARY_BYTES),
                ]),
            ));
            cases.push((
                "parent inside a name",
                super::test_support::archive(&[("../evil", b"x"), (ARCHIVE_BINARY, BINARY_BYTES)]),
            ));
        }
        for (name, bytes) in cases {
            let dir = tempfile::tempdir().unwrap();
            let installer = FakeInstaller::default();
            let restarter = FakeRestarter::default();
            let outcome = install_archive_for_test(dir.path(), &bytes, &installer, &restarter);
            let report = outcome
                .report()
                .expect("a rejected archive reports a failure");
            assert_eq!(
                serde_json::to_value(report).unwrap()["status"],
                "failed",
                "{name}"
            );
            assert_eq!(installer.calls(), 0, "{name}");
            assert_eq!(installer.backups(), 0, "{name}");
        }
    }

    #[test]
    fn install_failure_restores_the_previous_binary() {
        let dir = tempfile::tempdir().unwrap();
        let installer = FakeInstaller::default();
        installer.fail_install();
        let restarter = FakeRestarter::default();
        let bytes = super::test_support::archive(&[(ARCHIVE_BINARY, BINARY_BYTES)]);
        let outcome = install_archive_for_test(dir.path(), &bytes, &installer, &restarter);
        let report = outcome
            .report()
            .expect("an install failure reports a failure");
        assert_eq!(report.status, UpdateStatus::Failed);
        assert_eq!(installer.calls(), 2);
        assert_eq!(restarter.calls(), 0);
        let state = UpdateState::load(dir.path()).unwrap().unwrap();
        assert_eq!(state.pending, None);
    }

    fn reconcile_request<'a>(
        state_dir: &'a Path,
        config_path: &'a Path,
        token_path: &'a Path,
        installer: &'a FakeInstaller,
        restarter: &'a FakeRestarter,
    ) -> ReconcileRequest<'a> {
        ReconcileRequest {
            state_dir,
            current_version: env!("CARGO_PKG_VERSION"),
            config_path,
            token_path,
            installer,
            restarter,
            client: None,
        }
    }

    fn pending_state(state_dir: &Path, to: &str, attempts: u32) {
        let state = UpdateState {
            pending: Some(PendingUpdate {
                from: "0.1.0".to_string(),
                to: to.to_string(),
                attempts,
                staged_at: "2026-11-27T18:00:00.000Z".to_string(),
            }),
            confirmed: None,
        };
        state.save(state_dir).unwrap();
    }

    fn passing_self_check(dir: &Path) -> (PathBuf, PathBuf) {
        let token = dir.join("token");
        std::fs::write(&token, r#"{"runnerId":"runner-1","token":"runner-secret"}"#).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&token, std::fs::Permissions::from_mode(0o600)).unwrap();
        }
        let config = dir.join("config.toml");
        std::fs::write(
            &config,
            format!(
                "server_url = \"wss://intentra.example/api/runner\"\ntoken_path = \"{}\"\n",
                token.display()
            ),
        )
        .unwrap();
        (config, token)
    }

    #[tokio::test]
    async fn self_check_decides_only_the_first_unconfirmed_start() {
        let dir = tempfile::tempdir().unwrap();
        let (config, token) = passing_self_check(dir.path());

        pending_state(dir.path(), env!("CARGO_PKG_VERSION"), 0);
        let installer = FakeInstaller::default();
        let restarter = FakeRestarter::default();
        let kept = reconcile_pending(&reconcile_request(
            dir.path(),
            &config,
            &token,
            &installer,
            &restarter,
        ))
        .await;
        assert_eq!(kept, None, "a passing self-check must keep the update");
        assert_eq!(installer.calls(), 0);
        let state = UpdateState::load(dir.path()).unwrap().unwrap();
        assert_eq!(state.attempts(), 1, "the first attempt must be recorded");

        pending_state(dir.path(), env!("CARGO_PKG_VERSION"), 1);
        let installer = FakeInstaller::default();
        let restarter = FakeRestarter::default();
        let report = reconcile_pending(&reconcile_request(
            dir.path(),
            &config,
            &token,
            &installer,
            &restarter,
        ))
        .await
        .expect("an unconfirmed update rolls back even when the self-check would pass");
        assert_eq!(report.status, UpdateStatus::RolledBack);
        assert_eq!(installer.calls(), 1);
        assert_eq!(restarter.calls(), 1);
        let state = UpdateState::load(dir.path()).unwrap().unwrap();
        assert_eq!(state.pending, None);
    }

    #[tokio::test]
    async fn failed_self_check_rolls_back() {
        let dir = tempfile::tempdir().unwrap();
        let config = dir.path().join("missing-config.toml");
        let token = dir.path().join("token");
        pending_state(dir.path(), env!("CARGO_PKG_VERSION"), 0);
        let installer = FakeInstaller::default();
        let restarter = FakeRestarter::default();
        let report = reconcile_pending(&reconcile_request(
            dir.path(),
            &config,
            &token,
            &installer,
            &restarter,
        ))
        .await
        .expect("a failed self-check reports a rollback");
        assert_eq!(report.status, UpdateStatus::RolledBack);
        assert_eq!(installer.calls(), 1);
        assert_eq!(restarter.calls(), 1);
        let state = UpdateState::load(dir.path()).unwrap().unwrap();
        assert_eq!(state.pending, None);
    }

    #[tokio::test]
    async fn second_unconfirmed_start_rolls_back() {
        let dir = tempfile::tempdir().unwrap();
        let config = dir.path().join("missing-config.toml");
        let token = dir.path().join("token");
        pending_state(dir.path(), env!("CARGO_PKG_VERSION"), 1);
        let installer = FakeInstaller::default();
        let restarter = FakeRestarter::default();
        let report = reconcile_pending(&reconcile_request(
            dir.path(),
            &config,
            &token,
            &installer,
            &restarter,
        ))
        .await
        .expect("an unconfirmed update reports a rollback");
        assert_eq!(report.status, UpdateStatus::RolledBack);
        assert_eq!(installer.calls(), 1);
        assert_eq!(restarter.calls(), 1);
        let state = UpdateState::load(dir.path()).unwrap().unwrap();
        assert_eq!(state.pending, None);
    }

    #[tokio::test]
    async fn pending_for_another_version_is_discarded() {
        let dir = tempfile::tempdir().unwrap();
        let config = dir.path().join("missing-config.toml");
        let token = dir.path().join("token");
        pending_state(dir.path(), "0.9.9", 0);
        let installer = FakeInstaller::default();
        let restarter = FakeRestarter::default();
        let report = reconcile_pending(&reconcile_request(
            dir.path(),
            &config,
            &token,
            &installer,
            &restarter,
        ))
        .await;
        assert_eq!(report, None);
        assert_eq!(installer.calls(), 0);
        assert_eq!(restarter.calls(), 0);
        let state = UpdateState::load(dir.path()).unwrap().unwrap();
        assert_eq!(state.pending, None);
    }
}
