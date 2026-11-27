# Contributing

Intentra is proprietary software. External contributions are accepted only
under the terms below, and only after the contributor has explicitly accepted
them in the pull request.

## Contribution terms

By submitting a pull request, patch or any other material to this repository (a
"Contribution"), and by checking the contribution-terms box in the pull request
template, you agree that:

1. You are the sole author of the Contribution and have the right to grant the
   rights below, or your employer has authorized you to contribute on its
   behalf.
2. You grant Anton Maksimenkau a perpetual, worldwide, non-exclusive,
   royalty-free, irrevocable, sublicensable license to use, reproduce, modify,
   distribute, publicly display, publicly perform and otherwise exploit the
   Contribution, including in commercial and closed-source products and services.
3. To the extent permitted by applicable law, you assign to Anton Maksimenkau
   all right, title and interest in the Contribution, including copyright. Where
   an assignment is not permitted, you grant an exclusive license to the maximum
   extent allowed by law.
4. To the extent permitted by applicable law, you waive, and agree not to
   assert, any moral rights in the Contribution.
5. You grant a perpetual, worldwide, royalty-free, irrevocable patent license
   for any patents you own or control that are necessarily infringed by the
   Contribution.

If you are contributing in the course of employment, confirm that your employer
has authorized the contribution and the rights above.

No Contribution is accepted until the pull request template box is checked.
Maintainers may close pull requests that do not accept these terms.

## What to contribute

- Bug reports and feature proposals: open an issue first.
- Small fixes are welcome through pull requests that accept the terms above.
- Do not include code, assets or documentation copied from another project
  unless you have the right to license it under these terms.

## Review and gates

A pull request is merged only after the CI checks pass (`Node · typecheck,
lint, test, build` and `Rust · ubuntu-latest`, `Rust · macos-latest`,
`Rust · windows-latest`) and a maintainer approves the change.
