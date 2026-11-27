pub mod cli;
pub mod dsh;
pub mod host;
pub mod mock;

use std::sync::Arc;

use crate::adapter::{AdapterHost, AdapterRegistry, AgentAdapter};
use crate::config::Config;

pub async fn from_config(config: &Config, host: Arc<dyn AdapterHost>) -> AdapterRegistry {
    let mut registry = AdapterRegistry::default();
    if let Some(runtime) = config.runtimes.get(dsh::ID) {
        let adapter =
            dsh::DshAdapter::new(dsh::DshConfig::from_runtime(runtime), Arc::clone(&host));
        let detection = adapter.detect().await;
        if detection.available {
            registry.register(Arc::new(adapter));
        } else {
            tracing::warn!(
                reason = detection.reason.unwrap_or_default(),
                "DSH runtime is unavailable"
            );
        }
    }
    if let Some(runtime) = config.runtimes.get(cli::ID) {
        match cli::CliConfig::from_runtime(runtime) {
            Ok(settings) => {
                let adapter = cli::CliAdapter::new(settings, Arc::clone(&host));
                let detection = adapter.detect().await;
                if detection.available {
                    registry.register(Arc::new(adapter));
                } else {
                    tracing::warn!(
                        reason = detection.reason.unwrap_or_default(),
                        "generic CLI runtime is unavailable"
                    );
                }
            }
            Err(error) => tracing::warn!(error = %error, "skipping the generic CLI runtime"),
        }
    }
    if config.runtimes.contains_key(mock::ID) {
        registry.register(Arc::new(mock::MockAdapter::with_host(host)));
    }
    registry
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::adapter::NoHost;

    fn config(raw: &str) -> Config {
        toml::from_str(raw).unwrap()
    }

    #[tokio::test]
    async fn an_unconfigured_runner_registers_no_runtime() {
        let registry = from_config(
            &config("server_url = \"wss://example.test\""),
            Arc::new(NoHost),
        )
        .await;
        assert!(registry.is_empty());
    }

    #[tokio::test]
    async fn the_mock_runtime_is_registered_when_configured() {
        let registry = from_config(
            &config("server_url = \"wss://example.test\"\n\n[runtimes.mock]\n"),
            Arc::new(NoHost),
        )
        .await;
        assert_eq!(registry.infos()[0].id, "mock");
        assert!(registry.select("mock").is_some());
    }

    #[tokio::test]
    async fn a_missing_dsh_binary_registers_no_dsh_adapter() {
        let dir = tempfile::tempdir().unwrap();
        let raw = format!(
            "server_url = \"wss://example.test\"\n\n[runtimes.dsh]\nbinary = \"{}\"\n",
            dir.path()
                .join("no-such-dsh")
                .display()
                .to_string()
                .replace('\\', "/")
        );
        let registry = from_config(&config(&raw), Arc::new(NoHost)).await;
        assert!(registry.get("dsh").is_none());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_configured_cli_runtime_is_detected_by_its_binary() {
        let registry = from_config(
            &config("server_url = \"wss://example.test\"\n\n[runtimes.cli]\nbinary = \"sh\"\nargs = [\"-c\", \"cat\"]\n"),
            Arc::new(NoHost),
        )
        .await;
        assert!(registry.get("cli").is_some());
        let empty = from_config(
            &config("server_url = \"wss://example.test\"\n\n[runtimes.cli]\nbinary = \"intentra-missing-cli\"\n"),
            Arc::new(NoHost),
        )
        .await;
        assert!(empty.get("cli").is_none());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_dsh_offer_falls_back_to_the_generic_cli_adapter() {
        let registry = from_config(
            &config("server_url = \"wss://example.test\"\n\n[runtimes.cli]\nbinary = \"sh\"\nargs = [\"-c\", \"cat\"]\n"),
            Arc::new(NoHost),
        )
        .await;
        assert_eq!(
            registry.select("dsh").map(|adapter| adapter.info().id),
            Some("cli".to_string())
        );
    }
}
