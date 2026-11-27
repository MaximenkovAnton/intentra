# Release fixtures

Signed update manifest and test key pair shared by the contract tests
`packages/contracts/test/release.test.ts` and `crates/runner-core/src/update/`.

- `manifest.json` — compact UTF-8 JSON without a trailing newline (1826 bytes); the signature covers
  exactly these bytes.
- `manifest.sig` — Ed25519 signature over those bytes, base64 (64 bytes), trailing newline trimmed by
  the reader.
- `test.pub` / `test.seed` — test-only key pair, raw 32 bytes each, base64.
- The `sha256` values are synthetic: each equals `sha256(fileName)`, not the hash of a real archive.

## Why the seed is committed

The debug build reads its public key from `INTENTRA_UPDATE_PUBKEY`; the release build ignores that
variable and uses only the compiled `crates/runner-core/keys/release.pub`. The placeholder key fails
closed, so `test.seed` is never accepted by a release build — it exists only so the contract tests
can prove the signature path.

## Generating a new pair

The pair is reproducible: the seed is `sha256("intentra release fixture seed v1")`, the signature is
deterministic (RFC 8032). Regenerate with:

```bash
node --input-type=module -e '
import { readFileSync, writeFileSync } from "node:fs";
import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";
const seed = createHash("sha256").update("intentra release fixture seed v1").digest();
const privateKey = createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]), format: "der", type: "pkcs8" });
const rawPub = createPublicKey(privateKey).export({ format: "der", type: "spki" }).subarray(-32);
const bytes = readFileSync("fixtures/release/manifest.json");
writeFileSync("fixtures/release/test.seed", `${seed.toString("base64")}\n`);
writeFileSync("fixtures/release/test.pub", `${rawPub.toString("base64")}\n`);
writeFileSync("fixtures/release/manifest.sig", `${sign(null, bytes, privateKey).toString("base64")}\n`);
'
```

Changing the key pair or the manifest bytes requires re-signing `manifest.json`; otherwise the
contract tests reject the fixture.
