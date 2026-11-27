use std::collections::HashSet;
use std::sync::LazyLock;

use regex::Regex;
use serde::{Deserialize, Serialize};

use super::UpdateError;

pub use crate::config::Channel;

static SEMVER: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-((?:0|[1-9][0-9]*|[0-9]*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9]*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$")
        .expect("semver pattern compiles")
});
static PUBLISHED_AT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,9})?Z$")
        .expect("publishedAt pattern compiles")
});
static SHA256: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[0-9a-f]{64}$").expect("sha256 pattern compiles"));
static SIGNATURE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[A-Za-z0-9+/]{86}==$").expect("signature pattern compiles"));

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum Target {
    #[serde(rename = "x86_64-unknown-linux-gnu")]
    LinuxX86_64,
    #[serde(rename = "aarch64-unknown-linux-gnu")]
    LinuxAarch64,
    #[serde(rename = "x86_64-apple-darwin")]
    DarwinX86_64,
    #[serde(rename = "aarch64-apple-darwin")]
    DarwinAarch64,
    #[serde(rename = "x86_64-pc-windows-msvc")]
    WindowsX86_64,
}

impl Target {
    pub const ALL: [Target; 5] = [
        Target::LinuxX86_64,
        Target::LinuxAarch64,
        Target::DarwinX86_64,
        Target::DarwinAarch64,
        Target::WindowsX86_64,
    ];

    pub fn for_platform(os: &str, arch: &str, target_env: &str) -> Option<Target> {
        match (os, arch, target_env) {
            ("linux", "x86_64", "gnu") => Some(Target::LinuxX86_64),
            ("linux", "aarch64", "gnu") => Some(Target::LinuxAarch64),
            ("macos", "x86_64", _) => Some(Target::DarwinX86_64),
            ("macos", "aarch64", _) => Some(Target::DarwinAarch64),
            ("windows", "x86_64", "msvc") => Some(Target::WindowsX86_64),
            _ => None,
        }
    }

    pub fn current() -> Option<Target> {
        const TARGET_ENV: &str = if cfg!(target_env = "msvc") {
            "msvc"
        } else if cfg!(target_env = "gnu") {
            "gnu"
        } else {
            ""
        };
        Target::for_platform(std::env::consts::OS, std::env::consts::ARCH, TARGET_ENV)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpdateAsset {
    pub target: Target,
    pub file_name: String,
    pub url: String,
    pub size_bytes: u64,
    pub sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpdateManifest {
    pub schema_version: u32,
    pub version: String,
    pub channel: Channel,
    pub protocol_version: u32,
    pub published_at: String,
    pub notes: String,
    pub assets: Vec<UpdateAsset>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunnerUpdate {
    pub available: bool,
    pub channel: Channel,
    pub latest_version: Option<String>,
    pub pinned_version: Option<String>,
    pub auto_update: bool,
    pub manifest: Option<String>,
    pub signature: Option<String>,
    pub reason: Option<String>,
}

fn invalid(message: &str) -> UpdateError {
    UpdateError::ManifestInvalid(message.to_string())
}

impl UpdateAsset {
    fn validate(&self) -> Result<(), UpdateError> {
        if self.file_name.trim().is_empty() {
            return Err(invalid("asset fileName must not be empty"));
        }
        if self.size_bytes == 0 {
            return Err(invalid("asset sizeBytes must be positive"));
        }
        if !SHA256.is_match(&self.sha256) {
            return Err(invalid("asset sha256 must be 64 lowercase hex characters"));
        }
        let url = reqwest::Url::parse(&self.url)
            .map_err(|_| invalid("asset url must be an absolute URL"))?;
        if url.scheme() != "https" || url.host().is_none() {
            return Err(invalid("asset url must be an absolute https URL"));
        }
        Ok(())
    }
}

impl UpdateManifest {
    pub fn validate(&self) -> Result<(), UpdateError> {
        if self.schema_version != 1 {
            return Err(UpdateError::UnsupportedSchemaVersion(self.schema_version));
        }
        if self.protocol_version < 1 {
            return Err(invalid("protocolVersion must be at least 1"));
        }
        if !SEMVER.is_match(&self.version) {
            return Err(invalid("version must be SemVer 2.0.0"));
        }
        if !PUBLISHED_AT.is_match(&self.published_at)
            || crate::util::parse_iso(&self.published_at).is_none()
        {
            return Err(invalid("publishedAt must be an RFC 3339 UTC timestamp"));
        }
        if self.assets.len() != Target::ALL.len() {
            return Err(invalid("assets must contain exactly five entries"));
        }
        let mut targets = HashSet::new();
        let mut file_names = HashSet::new();
        for asset in &self.assets {
            asset.validate()?;
            if !targets.insert(asset.target) {
                return Err(invalid("each target must appear exactly once"));
            }
            if !file_names.insert(asset.file_name.as_str()) {
                return Err(invalid("asset fileNames must be unique"));
            }
        }
        Ok(())
    }
}

pub const AUTO_UPDATE_DISABLED_REASON: &str = "auto-updates are disabled for this runner (autoUpdate=false); enable auto-update in the centre before applying";

impl RunnerUpdate {
    pub fn apply_blocker(&self) -> Option<&'static str> {
        (!self.auto_update).then_some(AUTO_UPDATE_DISABLED_REASON)
    }

    pub fn validate(&self) -> Result<(), UpdateError> {
        if self.available {
            let manifest = self
                .manifest
                .as_deref()
                .ok_or_else(|| invalid("an available update requires a manifest"))?;
            let signature = self
                .signature
                .as_deref()
                .ok_or_else(|| invalid("an available update requires a signature"))?;
            if manifest.trim().is_empty() {
                return Err(invalid("manifest must not be empty"));
            }
            if !SIGNATURE.is_match(signature.trim()) {
                return Err(invalid("signature must be a base64 Ed25519 signature"));
            }
        } else if self.manifest.is_some() || self.signature.is_some() {
            return Err(invalid(
                "an unavailable update must not carry a manifest or signature",
            ));
        }
        for version in [
            self.latest_version.as_deref(),
            self.pinned_version.as_deref(),
        ]
        .into_iter()
        .flatten()
        {
            if !SEMVER.is_match(version) {
                return Err(invalid("latestVersion and pinnedVersion must be SemVer"));
            }
        }
        Ok(())
    }
}

pub fn parse_manifest(bytes: &[u8]) -> Result<UpdateManifest, UpdateError> {
    let manifest: UpdateManifest = serde_json::from_slice(bytes)
        .map_err(|error| UpdateError::ManifestInvalid(error.to_string()))?;
    manifest.validate()?;
    Ok(manifest)
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    use super::*;
    use crate::update::fixtures;

    fn manifest_value() -> Value {
        serde_json::from_str(fixtures::MANIFEST_JSON).expect("fixture is JSON")
    }

    fn with(path: &[&str], value: Value) -> Value {
        let mut manifest = manifest_value();
        let (last, parents) = path.split_last().expect("path is not empty");
        let mut node = &mut manifest;
        for segment in parents {
            node = match segment.parse::<usize>() {
                Ok(index) => &mut node[index],
                Err(_) => node.get_mut(*segment).expect("path segment exists"),
            };
        }
        node[*last] = value;
        manifest
    }

    fn parse_value(value: &Value) -> Result<UpdateManifest, UpdateError> {
        parse_manifest(&serde_json::to_vec(value).expect("value encodes"))
    }

    fn base_update(fields: &[(&str, Value)]) -> Value {
        let mut update = json!({
            "channel": "stable",
            "latestVersion": "0.2.0",
            "pinnedVersion": null,
            "autoUpdate": true,
        });
        for (key, value) in fields {
            update[*key] = value.clone();
        }
        update
    }

    fn parse_update(value: &Value) -> Result<RunnerUpdate, UpdateError> {
        let update: RunnerUpdate = serde_json::from_value(value.clone())
            .map_err(|error| UpdateError::ManifestInvalid(error.to_string()))?;
        update.validate()?;
        Ok(update)
    }

    #[test]
    fn target_for_platform_maps_the_five_triples() {
        let cases = [
            (
                ("linux", "x86_64", "gnu"),
                Some(Target::LinuxX86_64),
                "x86_64-unknown-linux-gnu",
            ),
            (
                ("linux", "aarch64", "gnu"),
                Some(Target::LinuxAarch64),
                "aarch64-unknown-linux-gnu",
            ),
            (
                ("macos", "x86_64", ""),
                Some(Target::DarwinX86_64),
                "x86_64-apple-darwin",
            ),
            (
                ("macos", "aarch64", ""),
                Some(Target::DarwinAarch64),
                "aarch64-apple-darwin",
            ),
            (
                ("windows", "x86_64", "msvc"),
                Some(Target::WindowsX86_64),
                "x86_64-pc-windows-msvc",
            ),
            (("linux", "riscv64", "gnu"), None, ""),
        ];
        for ((os, arch, env), expected, name) in cases {
            assert_eq!(Target::for_platform(os, arch, env), expected);
            if let Some(target) = expected {
                assert_eq!(serde_json::to_value(target).unwrap(), json!(name));
            }
        }
        assert!(Target::current().is_some());
        assert!(Target::ALL.contains(&Target::current().unwrap()));
    }

    #[test]
    fn shared_fixture_matches_the_release_contract() {
        let manifest = parse_manifest(fixtures::MANIFEST_JSON.as_bytes()).expect("fixture parses");
        assert_eq!(manifest.version, "0.2.0");
        assert_eq!(manifest.assets.len(), 5);
        for (asset, target) in manifest.assets.iter().zip(Target::ALL) {
            assert_eq!(asset.target, target);
        }
        let hashes = [
            "0294240bb72986e3f97d8188eb28a9ffc4d9a119683f269ffac658bd3eb664ea",
            "e8c58faa9002fa24d88073aad22c7354c1e5d2d7124bd67132f3d635da36a010",
            "38f65af3ad37681f3d767eda97949df06b10e6f1aef6aa60176933539217b348",
            "c1861226d6643dec660cd6942ff0c8c5bd5afbcfb0d9607bef063f0eb18ecec1",
            "8a6f81197ea82d56bba33bca18f2bee3661fc1b4fa7d3743a254ed9f130a2eb7",
        ];
        for (asset, hash) in manifest.assets.iter().zip(hashes) {
            assert_eq!(asset.sha256, hash);
        }
    }

    #[test]
    fn rejects_unknown_fields_on_manifest_and_update_response() {
        let mut manifest = manifest_value();
        manifest["extra"] = json!(true);
        assert!(serde_json::from_str::<UpdateManifest>(&manifest.to_string()).is_err());
        let mut update = base_update(&[("available", json!(false))]);
        update["extra"] = json!(true);
        assert!(serde_json::from_str::<RunnerUpdate>(&update.to_string()).is_err());
    }

    #[test]
    fn enforces_the_runner_update_invariant() {
        let manifest = json!(fixtures::MANIFEST_JSON);
        let signature = json!(fixtures::MANIFEST_SIG.trim());
        let rejected = [
            base_update(&[
                ("available", json!(false)),
                ("manifest", manifest.clone()),
                ("signature", signature.clone()),
            ]),
            base_update(&[("available", json!(true)), ("signature", signature.clone())]),
            base_update(&[("available", json!(true)), ("manifest", manifest.clone())]),
            base_update(&[("available", json!(true))]),
        ];
        for update in rejected {
            assert!(matches!(
                parse_update(&update),
                Err(UpdateError::ManifestInvalid(_))
            ));
        }
        let accepted = [
            base_update(&[
                ("available", json!(true)),
                ("manifest", manifest.clone()),
                ("signature", signature.clone()),
            ]),
            json!({
                "available": false,
                "channel": "stable",
                "latestVersion": null,
                "pinnedVersion": null,
                "autoUpdate": true,
            }),
            json!({
                "available": false,
                "channel": "stable",
                "latestVersion": null,
                "pinnedVersion": null,
                "autoUpdate": false,
                "reason": "pinned by admin",
            }),
        ];
        for update in accepted {
            assert!(parse_update(&update).is_ok(), "must accept {update}");
        }
    }

    #[test]
    fn rejects_invalid_asset_sets() {
        let mut four = manifest_value();
        let _ = four["assets"]
            .as_array_mut()
            .expect("assets is an array")
            .pop();
        let mut six = manifest_value();
        let first = six["assets"][0].clone();
        six["assets"]
            .as_array_mut()
            .expect("assets is an array")
            .push(first);
        let mut duplicate_target = manifest_value();
        duplicate_target["assets"][1]["target"] = json!("x86_64-unknown-linux-gnu");
        let mut duplicate_file_name = manifest_value();
        duplicate_file_name["assets"][1]["fileName"] =
            json!("intentra-runner-0.2.0-x86_64-unknown-linux-gnu.tar.gz");
        for (name, value) in [
            ("four", four),
            ("six", six),
            ("duplicate target", duplicate_target),
            ("duplicate fileName", duplicate_file_name),
        ] {
            assert!(
                matches!(parse_value(&value), Err(UpdateError::ManifestInvalid(_))),
                "{name} must be rejected"
            );
        }
        assert!(parse_value(&manifest_value()).is_ok());
    }

    #[test]
    fn validates_semver_sha256_https_and_manifest_header() {
        let cases: Vec<(&str, Value, bool)> = vec![
            ("release semver", with(&["version"], json!("0.2.0")), true),
            (
                "prerelease semver",
                with(&["version"], json!("0.2.0-beta.1")),
                true,
            ),
            (
                "prerelease with build metadata",
                with(&["version"], json!("0.2.0-rc.1+build.5")),
                true,
            ),
            (
                "v-prefixed semver",
                with(&["version"], json!("v0.2.0")),
                false,
            ),
            ("two-part semver", with(&["version"], json!("0.2")), false),
            (
                "empty prerelease",
                with(&["version"], json!("0.2.0-")),
                false,
            ),
            (
                "leading zero prerelease",
                with(&["version"], json!("0.2.0-01")),
                false,
            ),
            (
                "leading zero major",
                with(&["version"], json!("01.2.3")),
                false,
            ),
            (
                "uppercase sha256",
                with(&["assets", "0", "sha256"], json!("A".repeat(64))),
                false,
            ),
            (
                "short sha256",
                with(&["assets", "0", "sha256"], json!("0".repeat(63))),
                false,
            ),
            (
                "http url",
                with(
                    &["assets", "0", "url"],
                    json!("http://example.com/runner.tar.gz"),
                ),
                false,
            ),
            (
                "ftp url",
                with(
                    &["assets", "0", "url"],
                    json!("ftp://example.com/runner.tar.gz"),
                ),
                false,
            ),
            (
                "non-url",
                with(&["assets", "0", "url"], json!("not a url")),
                false,
            ),
            (
                "https url",
                with(
                    &["assets", "0", "url"],
                    json!("https://example.com/runner.tar.gz"),
                ),
                true,
            ),
            ("schemaVersion 2", with(&["schemaVersion"], json!(2)), false),
            (
                "protocolVersion 0",
                with(&["protocolVersion"], json!(0)),
                false,
            ),
            (
                "protocolVersion fractional",
                with(&["protocolVersion"], json!(1.5)),
                false,
            ),
            (
                "sizeBytes 0",
                with(&["assets", "0", "sizeBytes"], json!(0)),
                false,
            ),
            (
                "sizeBytes negative",
                with(&["assets", "0", "sizeBytes"], json!(-1)),
                false,
            ),
            (
                "empty fileName",
                with(&["assets", "0", "fileName"], json!("")),
                false,
            ),
            (
                "publishedAt offset",
                with(&["publishedAt"], json!("2026-11-27T18:00:00+03:00")),
                false,
            ),
            (
                "publishedAt space",
                with(&["publishedAt"], json!("2026-11-27 18:00:00Z")),
                false,
            ),
            (
                "publishedAt without fraction",
                with(&["publishedAt"], json!("2026-11-27T18:00:00Z")),
                true,
            ),
            (
                "publishedAt milliseconds",
                with(&["publishedAt"], json!("2026-11-27T18:00:00.000Z")),
                true,
            ),
            (
                "protocolVersion 1",
                with(&["protocolVersion"], json!(1)),
                true,
            ),
            (
                "sizeBytes 1",
                with(&["assets", "0", "sizeBytes"], json!(1)),
                true,
            ),
        ];
        for (name, value, valid) in cases {
            let result = parse_value(&value);
            assert_eq!(result.is_ok(), valid, "{name}: {result:?}");
        }
        assert!(matches!(
            parse_value(&with(&["schemaVersion"], json!(2))),
            Err(UpdateError::UnsupportedSchemaVersion(2))
        ));
    }
}
