# Contributing

Intentra is proprietary software. External contributions are accepted only
after the contributor signs the Contributor License Agreement below.

## Contributor License Agreement

External contributions are accepted only after you sign the
[Contributor License Agreement](CLA.md). To sign, comment this exact sentence on
your pull request:

> I have read the CLA Document and I hereby sign the CLA

The CLA workflow records your signature in the `cla-signatures` branch. If you
contribute in the course of employment, confirm that your employer has
authorized the Contribution and the rights granted in the CLA.

Pull requests without a recorded signature are not merged. Maintainers may
close pull requests that do not accept the CLA.

## What to contribute

- Bug reports and feature proposals: open an issue first.
- Small fixes are welcome through pull requests that sign the CLA.
- Do not include code, assets or documentation copied from another project
  unless you have the right to license it under these terms.

## Review and gates

A pull request is merged only after the CI checks pass (`Node · typecheck,
lint, test, build` and `Rust · ubuntu-latest`, `Rust · macos-latest`,
`Rust · windows-latest`) and a maintainer approves the change.
