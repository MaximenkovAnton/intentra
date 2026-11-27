use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::util::{expand_tilde, inside_roots, is_valid_ws_url};

pub const DEFAULT_TOKEN_PATH: &str = "~/.intentra/token";
pub const DEFAULT_LOG_LEVEL: &str = "info";
pub const DEFAULT_MAX_CONCURRENT_JOBS: u32 = 1;
pub const DEFAULT_UPDATE_CHECK_INTERVAL_MIN: u64 = 360;
pub const MIN_UPDATE_CHECK_INTERVAL_MIN: u64 = 5;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Channel {
    #[default]
    Stable,
    Beta,
}

impl Channel {
    pub fn as_str(self) -> &'static str {
        match self {
            Channel::Stable => "stable",
            Channel::Beta => "beta",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct UpdateConfig {
    pub enabled: bool,
    pub channel: Channel,
    pub check_interval_min: u64,
    pub allow_insecure_http: bool,
}

impl Default for UpdateConfig {
    fn default() -> Self {
        UpdateConfig {
            enabled: true,
            channel: Channel::Stable,
            check_interval_min: DEFAULT_UPDATE_CHECK_INTERVAL_MIN,
            allow_insecure_http: false,
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PromptMode {
    #[default]
    Stdin,
    Arg,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OutputMode {
    #[default]
    Text,
    Jsonl,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct RuntimeConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub binary: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dsh_home: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub args: Vec<String>,
    #[serde(default, skip_serializing_if = "is_default_prompt_mode")]
    pub prompt_mode: PromptMode,
    #[serde(default, skip_serializing_if = "is_default_output_mode")]
    pub output_mode: OutputMode,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_sec: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result_file: Option<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub env: BTreeMap<String, String>,
}

fn is_default_prompt_mode(mode: &PromptMode) -> bool {
    *mode == PromptMode::Stdin
}

fn is_default_output_mode(mode: &OutputMode) -> bool {
    *mode == OutputMode::Text
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    pub server_url: String,
    #[serde(default = "default_token_path")]
    pub token_path: String,
    #[serde(default)]
    pub workspaces: BTreeMap<String, String>,
    #[serde(default)]
    pub runtimes: BTreeMap<String, RuntimeConfig>,
    #[serde(default)]
    pub allow_roots: Vec<String>,
    #[serde(default = "default_log_level")]
    pub log_level: String,
    #[serde(default = "default_max_concurrent_jobs")]
    pub max_concurrent_jobs: u32,
    #[serde(default)]
    pub update: UpdateConfig,
}

fn default_token_path() -> String {
    DEFAULT_TOKEN_PATH.to_string()
}

fn default_log_level() -> String {
    DEFAULT_LOG_LEVEL.to_string()
}

fn default_max_concurrent_jobs() -> u32 {
    DEFAULT_MAX_CONCURRENT_JOBS
}

#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    #[error("cannot read config {path}: {source}")]
    Read {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("invalid TOML in {path}: {source}")]
    Parse {
        path: PathBuf,
        #[source]
        source: Box<toml::de::Error>,
    },
    #[error("server_url must be a ws:// or wss:// URL, got {0}")]
    ServerUrl(String),
    #[error("token_path must not be empty")]
    TokenPath,
    #[error("unknown log_level {0}; expected trace, debug, info, warn or error")]
    LogLevel(String),
    #[error("max_concurrent_jobs must be at least 1")]
    MaxConcurrentJobs,
    #[error("allow_roots must name existing directories, got {0}")]
    AllowRoot(String),
    #[error("workspace {key} must be an absolute path inside allow_roots, got {path}")]
    Workspace { key: String, path: String },
    #[error("update.check_interval_min must be at least {MIN_UPDATE_CHECK_INTERVAL_MIN}")]
    UpdateCheckInterval,
}

impl Config {
    pub fn load(path: &Path) -> Result<Config, ConfigError> {
        let raw = std::fs::read_to_string(path).map_err(|source| ConfigError::Read {
            path: path.to_path_buf(),
            source,
        })?;
        let config: Config = toml::from_str(&raw).map_err(|source| ConfigError::Parse {
            path: path.to_path_buf(),
            source: Box::new(source),
        })?;
        config.validate()?;
        Ok(config)
    }

    pub fn validate(&self) -> Result<(), ConfigError> {
        if !is_valid_ws_url(&self.server_url) {
            return Err(ConfigError::ServerUrl(self.server_url.clone()));
        }
        if self.token_path.trim().is_empty() {
            return Err(ConfigError::TokenPath);
        }
        if !matches!(
            self.log_level.as_str(),
            "trace" | "debug" | "info" | "warn" | "error"
        ) {
            return Err(ConfigError::LogLevel(self.log_level.clone()));
        }
        if self.max_concurrent_jobs < 1 {
            return Err(ConfigError::MaxConcurrentJobs);
        }
        if self.update.check_interval_min < MIN_UPDATE_CHECK_INTERVAL_MIN {
            return Err(ConfigError::UpdateCheckInterval);
        }
        let roots = self.roots();
        for workspace in self.workspaces.values() {
            let path = expand_tilde(workspace);
            if !path.is_absolute() || !inside_roots(&path, &roots) {
                return Err(ConfigError::Workspace {
                    key: workspace.clone(),
                    path: workspace.clone(),
                });
            }
        }
        Ok(())
    }

    pub fn roots(&self) -> Vec<PathBuf> {
        self.allow_roots
            .iter()
            .map(|root| expand_tilde(root))
            .filter(|root| {
                if root.is_dir() {
                    true
                } else {
                    tracing::warn!(root = %root.display(), "allow_root does not exist");
                    false
                }
            })
            .collect()
    }

    pub fn workspace(&self, project_key: &str) -> Option<PathBuf> {
        self.workspaces
            .get(project_key)
            .map(|path| expand_tilde(path))
    }

    pub fn token_path(&self) -> PathBuf {
        expand_tilde(&self.token_path)
    }

    pub fn state_dir(&self) -> PathBuf {
        self.token_path()
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| PathBuf::from("."))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base_config() -> Config {
        Config {
            server_url: "wss://intentra.example/api/runner".to_string(),
            token_path: "/tmp/intentra-token".to_string(),
            workspaces: BTreeMap::new(),
            runtimes: BTreeMap::new(),
            allow_roots: vec![],
            log_level: "info".to_string(),
            max_concurrent_jobs: 1,
            update: UpdateConfig::default(),
        }
    }

    #[test]
    fn defaults_fill_optional_fields() {
        let config: Config = toml::from_str("server_url = \"wss://example.test/runner\"").unwrap();
        assert_eq!(config.token_path, DEFAULT_TOKEN_PATH);
        assert_eq!(config.log_level, "info");
        assert_eq!(config.max_concurrent_jobs, 1);
        assert!(config.validate().is_ok());
    }

    #[test]
    fn plain_http_is_not_a_runner_server_url() {
        let mut config = base_config();
        config.server_url = "https://example.test".to_string();
        assert!(matches!(config.validate(), Err(ConfigError::ServerUrl(_))));
    }

    #[test]
    fn zero_concurrent_jobs_is_rejected() {
        let mut config = base_config();
        config.max_concurrent_jobs = 0;
        assert!(matches!(
            config.validate(),
            Err(ConfigError::MaxConcurrentJobs)
        ));
    }

    #[test]
    fn workspaces_outside_allow_roots_are_rejected() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let mut config = base_config();
        config.allow_roots = vec![root.path().display().to_string()];
        config.workspaces =
            BTreeMap::from([("p".to_string(), outside.path().display().to_string())]);
        assert!(matches!(
            config.validate(),
            Err(ConfigError::Workspace { .. })
        ));
        config.workspaces = BTreeMap::from([("p".to_string(), root.path().display().to_string())]);
        assert!(config.validate().is_ok());
    }

    #[test]
    fn unknown_keys_are_rejected() {
        let raw = "server_url = \"wss://example.test\"\nsecret = \"x\"\n";
        assert!(toml::from_str::<Config>(raw).is_err());
    }

    #[test]
    fn runtime_entries_carry_the_generic_cli_and_dsh_settings() {
        let raw = "server_url = \"wss://example.test\"\n\n[runtimes.dsh]\nbinary = \"dsh\"\nmodel = \"deepseek-flash\"\nprovider = \"deepseek-official\"\n\n[runtimes.cli]\nbinary = \"codex\"\nargs = [\"exec\"]\nprompt_mode = \"arg\"\noutput_mode = \"jsonl\"\ntimeout_sec = 900\nresult_file = \".intentra/result.json\"\n\n[runtimes.cli.env]\nCODEX_HOME = \"/var/lib/codex\"\n";
        let config: Config = toml::from_str(raw).unwrap();
        let cli = config.runtimes.get("cli").unwrap();
        assert_eq!(cli.prompt_mode, PromptMode::Arg);
        assert_eq!(cli.output_mode, OutputMode::Jsonl);
        assert_eq!(cli.args, vec!["exec".to_string()]);
        assert_eq!(cli.timeout_sec, Some(900));
        assert_eq!(
            cli.env.get("CODEX_HOME").map(String::as_str),
            Some("/var/lib/codex")
        );
        assert_eq!(
            config.runtimes.get("dsh").unwrap().model.as_deref(),
            Some("deepseek-flash")
        );
    }

    #[test]
    fn update_section_defaults() {
        let config: Config = toml::from_str("server_url = \"wss://example.test\"").unwrap();
        assert_eq!(
            config.update,
            UpdateConfig {
                enabled: true,
                channel: Channel::Stable,
                check_interval_min: 360,
                allow_insecure_http: false,
            }
        );
        assert!(config.validate().is_ok());
        let explicit: Config = toml::from_str(
            "server_url = \"wss://example.test\"\n\n[update]\nchannel = \"stable\"\nenabled = true\n",
        )
        .unwrap();
        assert_eq!(explicit.update.channel, Channel::Stable);
        assert_eq!(explicit.update.check_interval_min, 360);
    }

    fn load_update_section(section: &str) -> Result<Config, ConfigError> {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.toml");
        std::fs::write(
            &path,
            format!("server_url = \"wss://example.test\"\n\n[update]\n{section}"),
        )
        .unwrap();
        Config::load(&path)
    }

    #[test]
    fn invalid_update_sections_are_rejected() {
        for section in [
            "channel = \"nightly\"\n",
            "allow_insecure_http = \"yes\"\n",
            "jitter = 5\n",
        ] {
            assert!(
                matches!(load_update_section(section), Err(ConfigError::Parse { .. })),
                "{section} must be a parse error"
            );
        }
        assert!(matches!(
            load_update_section("check_interval_min = 4\n"),
            Err(ConfigError::UpdateCheckInterval)
        ));
        assert!(matches!(
            load_update_section("check_interval_min = 5\n"),
            Ok(config) if config.update.check_interval_min == 5
        ));
    }

    #[test]
    fn a_misspelled_runtime_setting_is_rejected() {
        let raw = "server_url = \"wss://example.test\"\n\n[runtimes.cli]\npromptmode = \"arg\"\n";
        assert!(toml::from_str::<Config>(raw).is_err());
    }
}
