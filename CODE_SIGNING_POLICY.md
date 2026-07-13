# Code signing policy

## Status

Ninety is applying for the SignPath Foundation open-source code-signing
program. Releases are not represented as SignPath-signed until the application
has been accepted and the signing workflow has been enabled.

After acceptance, the following notice will apply to production releases:

> Free code signing provided by [SignPath.io](https://about.signpath.io/), certificate
> by [SignPath Foundation](https://signpath.org/).

## Project ownership and roles

The source repository, build definitions and release process are maintained by
the Ninety project team.

- Authors and committers: [@pathetixx](https://github.com/pathetixx)
- Reviewers: [@pathetixx](https://github.com/pathetixx)
- Signing approvers: [@pathetixx](https://github.com/pathetixx)

Changes from contributors who do not have commit access must be reviewed before
they are merged. Every production signing request requires manual approval by a
signing approver. Accounts with repository or SignPath access must use
multi-factor authentication.

## What is signed

Production signatures are limited to release artifacts produced from this
repository by the tag-triggered GitHub Actions workflow on GitHub-hosted
Windows runners:

- the Ninety application executable;
- the Ninety NSIS installer;
- the Ninety MSI package.

The signing configuration must enforce the product name `Ninety` and the
release version embedded by the build. A release is published only after its
Authenticode signatures and Tauri updater signature have been verified.

Ninety packages open-source upstream networking components. These components
are pinned or checksum-verified by the build and remain under their respective
upstream licenses. They are not to be signed as Ninety-owned binaries with the
SignPath Foundation certificate. The main runtime components and their roles
are documented in [Architecture](./docs/architecture.md); the bundled DPI
component retains its upstream notices in
[`src-tauri/dpi/LICENSE.flowseal.txt`](./src-tauri/dpi/LICENSE.flowseal.txt).

## Release integrity

- Release builds are produced only from annotated semantic-version tags.
- The tag version must match the application and package versions.
- GitHub Actions is the trusted build system and uses GitHub-hosted runners.
- Build scripts pin source revisions or verify downloaded artifacts by SHA-256.
- Signing inputs are uploaded as GitHub workflow artifacts before submission to
  SignPath.
- Signed output replaces unsigned release artifacts before publication.
- The Tauri updater signature is generated after Authenticode signing because
  Authenticode changes the installer bytes.
- Failed builds or failed signing requests are not published as a release.

See [Releasing](./RELEASING.md) for the complete release workflow.

## Privacy and security

Ninety does not include advertising, telemetry or a project-operated analytics
service. It makes network requests required for user-selected connections and
features, update delivery, public connectivity checks and optional IP/region
diagnostics. The data flows and user controls are described in the
[privacy policy](./docs/privacy.md).

Security vulnerabilities should be reported according to the
[security policy](./SECURITY.md).

Public facts prepared for the application review are collected in the
[SignPath Foundation application notes](./docs/signpath-application.md).

## Revocation and incidents

If a signing credential, build workflow or published artifact is suspected to
be compromised, the project will stop releases, investigate the affected build
and cooperate with SignPath Foundation. Affected signatures or certificates
may be revoked when necessary. Compromised releases will not be silently
replaced under the same version.
