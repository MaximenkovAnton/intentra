pub mod apply;
pub mod base64;
pub mod client;
pub mod daemon;
pub mod manifest;
pub mod signature;
pub mod state;

pub use manifest::{RunnerUpdate, UpdateAsset, UpdateManifest, parse_manifest};
pub use signature::{verify_manifest, verify_manifest_with_key};

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
    use std::sync::{Mutex, MutexGuard};

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
    pub const TEST_SEED: &str = include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../fixtures/release/test.seed"
    ));

    static ENV_LOCK: Mutex<()> = Mutex::new(());

    pub fn lock_env() -> MutexGuard<'static, ()> {
        ENV_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub struct TestPubkeyEnv;

    impl TestPubkeyEnv {
        pub fn set() -> TestPubkeyEnv {
            Self::set_value(TEST_PUB.trim())
        }

        pub fn set_placeholder() -> TestPubkeyEnv {
            Self::set_value(super::PLACEHOLDER_PUBKEY)
        }

        fn set_value(value: &str) -> TestPubkeyEnv {
            unsafe { std::env::set_var("INTENTRA_UPDATE_PUBKEY", value) };
            TestPubkeyEnv
        }

        pub fn clear() {
            unsafe { std::env::remove_var("INTENTRA_UPDATE_PUBKEY") };
        }
    }

    impl Drop for TestPubkeyEnv {
        fn drop(&mut self) {
            TestPubkeyEnv::clear();
        }
    }

    pub fn base64_encode(bytes: &[u8]) -> String {
        const ALPHABET: &[u8; 64] =
            b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let mut output = String::new();
        for chunk in bytes.chunks(3) {
            let first = u32::from(chunk[0]);
            let second = u32::from(chunk.get(1).copied().unwrap_or(0));
            let third = u32::from(chunk.get(2).copied().unwrap_or(0));
            let value = (first << 16) | (second << 8) | third;
            output.push(ALPHABET[(value >> 18 & 63) as usize] as char);
            output.push(ALPHABET[(value >> 12 & 63) as usize] as char);
            output.push(if chunk.len() > 1 {
                ALPHABET[(value >> 6 & 63) as usize] as char
            } else {
                '='
            });
            output.push(if chunk.len() > 2 {
                ALPHABET[(value & 63) as usize] as char
            } else {
                '='
            });
        }
        output
    }

    pub fn sign(manifest_bytes: &[u8]) -> String {
        use ed25519_dalek::Signer;

        let seed = super::base64::decode(TEST_SEED.trim(), "seed").expect("test seed decodes");
        let seed: [u8; 32] = seed.as_slice().try_into().expect("test seed is 32 bytes");
        let key = ed25519_dalek::SigningKey::from_bytes(&seed);
        base64_encode(&key.sign(manifest_bytes).to_bytes())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct CustomPubkeyEnv;

    impl CustomPubkeyEnv {
        fn set(value: &str) -> Self {
            unsafe { std::env::set_var("INTENTRA_UPDATE_PUBKEY", value) };
            CustomPubkeyEnv
        }
    }

    impl Drop for CustomPubkeyEnv {
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
        let _lock = fixtures::lock_env();
        let _env = CustomPubkeyEnv::set(fixtures::TEST_PUB.trim());
        assert_eq!(public_key(), decode_public_key(fixtures::TEST_PUB.trim()));
    }

    #[cfg(not(debug_assertions))]
    #[test]
    fn release_build_ignores_the_test_key_env() {
        let _lock = fixtures::lock_env();
        let _env = CustomPubkeyEnv::set(fixtures::TEST_PUB.trim());
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
        let embedded = decode_public_key(embedded_public_key())
            .expect("the embedded release public key decodes");
        let test_pub =
            base64::decode(fixtures::TEST_PUB.trim(), "pubkey").expect("test key decodes");
        assert_ne!(embedded.as_slice(), test_pub.as_slice());
    }
}
