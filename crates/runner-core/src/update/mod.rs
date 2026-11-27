pub mod base64;
pub mod manifest;
pub mod signature;

pub use manifest::{RunnerUpdate, UpdateAsset, UpdateManifest, parse_manifest};
pub use signature::verify_manifest;

pub const PLACEHOLDER_PUBKEY: &str = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum UpdateError {
    #[error("manifest is not valid JSON or violates the schema: {0}")]
    ManifestInvalid(String),
    #[error("unsupported manifest schemaVersion {0}")]
    UnsupportedSchemaVersion(u32),
    #[error("invalid base64 in {field}")]
    Base64Invalid { field: &'static str },
    #[error("invalid update public key")]
    KeyInvalid,
    #[error("update public key is the all-zero placeholder")]
    PlaceholderKey,
    #[error("invalid update signature")]
    SignatureInvalid,
}

pub fn embedded_public_key() -> &'static str {
    include_str!("../../keys/release.pub")
}

pub fn decode_public_key(b64: &str) -> Result<[u8; 32], UpdateError> {
    let value = b64.trim();
    if value == PLACEHOLDER_PUBKEY {
        return Err(UpdateError::PlaceholderKey);
    }
    let bytes = base64::decode(value, "pubkey")?;
    bytes
        .as_slice()
        .try_into()
        .map_err(|_| UpdateError::KeyInvalid)
}

pub fn public_key() -> Result<[u8; 32], UpdateError> {
    #[cfg(debug_assertions)]
    if let Some(value) = std::env::var("INTENTRA_UPDATE_PUBKEY")
        .ok()
        .filter(|value| !value.trim().is_empty())
    {
        return decode_public_key(&value);
    }
    decode_public_key(embedded_public_key())
}

#[cfg(test)]
pub(crate) mod fixtures {
    pub const MANIFEST_JSON: &str = include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../fixtures/release/manifest.json"
    ));
    pub const MANIFEST_SIG: &str = include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../fixtures/release/manifest.sig"
    ));
    pub const TEST_PUB: &str = include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../fixtures/release/test.pub"
    ));
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;

    static ENV_LOCK: Mutex<()> = Mutex::new(());

    struct UpdatePubkeyEnv;

    impl UpdatePubkeyEnv {
        fn set(value: &str) -> Self {
            unsafe { std::env::set_var("INTENTRA_UPDATE_PUBKEY", value) };
            UpdatePubkeyEnv
        }
    }

    impl Drop for UpdatePubkeyEnv {
        fn drop(&mut self) {
            unsafe { std::env::remove_var("INTENTRA_UPDATE_PUBKEY") };
        }
    }

    #[test]
    fn placeholder_key_fails_closed() {
        assert!(matches!(
            decode_public_key(PLACEHOLDER_PUBKEY),
            Err(UpdateError::PlaceholderKey)
        ));
    }

    #[cfg(debug_assertions)]
    #[test]
    fn debug_env_overrides_the_embedded_key() {
        let _lock = ENV_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let _env = UpdatePubkeyEnv::set(fixtures::TEST_PUB.trim());
        assert_eq!(public_key(), decode_public_key(fixtures::TEST_PUB.trim()));
    }

    #[cfg(not(debug_assertions))]
    #[test]
    fn release_build_ignores_the_test_key_env() {
        let _lock = ENV_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let _env = UpdatePubkeyEnv::set(fixtures::TEST_PUB.trim());
        let test_pub = decode_public_key(fixtures::TEST_PUB.trim()).expect("test key decodes");
        match public_key() {
            Err(UpdateError::PlaceholderKey) => {
                assert_eq!(embedded_public_key().trim(), PLACEHOLDER_PUBKEY);
            }
            Ok(key) => assert_ne!(key, test_pub),
            Err(error) => panic!("unexpected error: {error:?}"),
        }
        assert_eq!(
            base64::decode(embedded_public_key().trim(), "pubkey")
                .expect("embedded key decodes")
                .len(),
            32
        );
    }

    #[test]
    fn embedded_key_is_a_raw_32_byte_key() {
        let embedded =
            base64::decode(embedded_public_key().trim(), "pubkey").expect("embedded key decodes");
        assert_eq!(embedded.len(), 32);
        let test_pub =
            base64::decode(fixtures::TEST_PUB.trim(), "pubkey").expect("test key decodes");
        assert_ne!(embedded, test_pub);
    }
}
