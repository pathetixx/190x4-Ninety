# Security policy

Ninety is a desktop networking client. Security reports are taken seriously, especially issues that may expose user traffic, credentials, local configuration, update delivery, engine control, Windows proxy state, WARP keys, logs or runtime configs.

## Supported versions

Only the latest public release is actively supported for security fixes. If you reproduce a problem on an older build, please update first and try again on the newest release from [Releases](https://github.com/pathetixx/190x4-Ninety/releases).

## What to report privately

Please avoid publishing public proof-of-concept details for issues involving:

- subscription URL or profile credential leakage;
- private keys, WARP registration data or local backup state;
- command execution, path traversal or unsafe process spawning;
- update-channel integrity problems;
- Windows system proxy not being restored safely;
- kill switch bypasses or traffic leaks caused by the app;
- runtime config files remaining on disk with sensitive data;
- frontend injection through imported profile/subscription data.

## How to report

Use GitHub's private vulnerability reporting / Security Advisories if it is enabled for the repository.

If private reporting is not available, open a minimal public issue that says a security-sensitive report exists, but do **not** include secrets, full configs, private subscription links, tokens, UUIDs, private keys or exploit details. The maintainer can then move the discussion to a safer channel.

## Safe report template

When reporting, include as much non-sensitive context as possible:

```text
Ninety version:
Windows version:
Install type: MSI / NSIS / portable-dev
Connection mode: Proxy / System proxy / VPN · TUN
Feature area: import / subscription refresh / TUN / DPI / WARP / updater / logs / kill switch / other
Expected result:
Actual result:
Reproduction steps without real credentials:
Sanitized logs or screenshots:
```

## Handling secrets in logs

Before sharing logs publicly, remove:

- subscription URLs;
- access tokens;
- UUIDs and passwords;
- private keys;
- WARP account/device data;
- real server addresses if they are private;
- personally identifying paths or account names.

## Maintainer notes

Security fixes should prefer privacy-safe defaults: no direct network fallback unless explicit, no verbose logs by default, loopback-only control endpoints, strict cleanup of runtime config files, and explicit confirmation for destructive sensitive-data actions.
