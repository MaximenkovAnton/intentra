# Changelog

All notable changes to Intentra are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-11-27

### Added

- Signed runner releases: one tag builds the `intentra-runner` binary for five targets, publishes
  the archives with their SHA-256 checksums and an Ed25519-signed `update-manifest.json` on GitHub
  Releases.
- Self-update: the runner checks the centre for a newer release, verifies the manifest signature and
  the archive checksum, replaces the binary only when no job is active, and rolls back when the new
  binary fails to start.

### Changed

- The workspace version is now `0.2.0`; `intentra-runner --version` and the `hello` message report it.

[Unreleased]: https://github.com/MaximenkovAnton/intentra/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/MaximenkovAnton/intentra/compare/v0.1.0...v0.2.0
