use ed25519_dalek::{Signature, VerifyingKey};

use super::{UpdateError, base64};

pub fn verify_manifest(
    manifest_bytes: &[u8],
    signature_b64: &str,
    pubkey_b64: &str,
) -> Result<(), UpdateError> {
    let key_bytes = base64::decode(pubkey_b64.trim(), "pubkey")?;
    let key_array: [u8; 32] = key_bytes
        .as_slice()
        .try_into()
        .map_err(|_| UpdateError::KeyInvalid)?;
    let key = VerifyingKey::from_bytes(&key_array).map_err(|_| UpdateError::KeyInvalid)?;
    let signature_bytes = base64::decode(signature_b64.trim(), "signature")?;
    let signature =
        Signature::from_slice(&signature_bytes).map_err(|_| UpdateError::SignatureInvalid)?;
    key.verify_strict(manifest_bytes, &signature)
        .map_err(|_| UpdateError::SignatureInvalid)
}

#[cfg(test)]
mod tests {
    use ed25519_dalek::SigningKey;

    use super::*;
    use crate::update::fixtures;

    fn base64_encode(bytes: &[u8]) -> String {
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

    #[test]
    fn verify_manifest_accepts_the_shared_fixture() {
        assert_eq!(
            verify_manifest(
                fixtures::MANIFEST_JSON.as_bytes(),
                fixtures::MANIFEST_SIG.trim(),
                fixtures::TEST_PUB.trim(),
            ),
            Ok(())
        );
    }

    #[test]
    fn verify_manifest_rejects_a_tampered_byte() {
        let mut bytes = fixtures::MANIFEST_JSON.as_bytes().to_vec();
        bytes[10] ^= 0x01;
        assert!(matches!(
            verify_manifest(
                &bytes,
                fixtures::MANIFEST_SIG.trim(),
                fixtures::TEST_PUB.trim()
            ),
            Err(UpdateError::SignatureInvalid)
        ));
    }

    #[test]
    fn verify_manifest_rejects_a_foreign_key() {
        let foreign = SigningKey::from_bytes(&[7u8; 32]);
        let foreign_pubkey = base64_encode(&foreign.verifying_key().to_bytes());
        assert!(matches!(
            verify_manifest(
                fixtures::MANIFEST_JSON.as_bytes(),
                fixtures::MANIFEST_SIG.trim(),
                &foreign_pubkey,
            ),
            Err(UpdateError::SignatureInvalid)
        ));
    }

    #[test]
    fn verify_manifest_rejects_malformed_base64_and_keys() {
        let bytes = fixtures::MANIFEST_JSON.as_bytes();
        let signature = fixtures::MANIFEST_SIG.trim();
        let pubkey = fixtures::TEST_PUB.trim();
        assert!(matches!(
            verify_manifest(bytes, &"A".repeat(87), pubkey),
            Err(UpdateError::Base64Invalid { field: "signature" })
        ));
        assert!(matches!(
            verify_manifest(bytes, signature, &"A".repeat(31)),
            Err(UpdateError::Base64Invalid { field: "pubkey" })
        ));
        assert!(matches!(
            verify_manifest(bytes, signature, "!!!!"),
            Err(UpdateError::Base64Invalid { field: "pubkey" })
        ));
        let wrong_length_key = base64_encode(&[7u8; 31]);
        assert!(matches!(
            verify_manifest(bytes, signature, &wrong_length_key),
            Err(UpdateError::KeyInvalid)
        ));
        let wrong_length_signature = base64_encode(&[7u8; 63]);
        assert!(matches!(
            verify_manifest(bytes, &wrong_length_signature, pubkey),
            Err(UpdateError::SignatureInvalid)
        ));
    }
}
