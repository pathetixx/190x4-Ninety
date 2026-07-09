# Privacy and local data

Ninety is a local Windows networking client. It does not run a hosted VPN service, and it does not make a server or provider trustworthy by itself.

## What may be stored locally

Depending on what you use, Ninety can store:

- imported profiles and subscriptions;
- active source and selected node state;
- user settings;
- WARP registration and endpoint state;
- traffic and quality history used by the UI;
- update state;
- runtime backup state for session restore;
- logs written by the app and helper engines.

Some of this data may identify your provider, server, account or local Windows user. Treat the app data directory, exports and logs as sensitive.

## Sensitive profile and subscription data

Profiles and subscriptions can contain credentials, including:

- subscription URLs;
- UUIDs and passwords;
- access tokens;
- private keys;
- server addresses;
- transport-specific secrets.

Do not paste real profiles, full configs or raw subscription responses into public issues. Use placeholders and sanitized logs.

## WARP keys and backup state

WARP/WireGuard state can contain key material and device/account data. Where supported by the backend, Ninety encrypts WARP keys and state backups with Windows DPAPI.

DPAPI protects data for the local Windows environment. It does not make copied logs, screenshots or manually exported files safe to publish.

## Logs

The default engine log level is `warn`. This reduces the chance of writing visited domains or detailed connection metadata to disk during normal use.

Logs can still contain sensitive context. Before sharing them, remove credentials, private endpoints, account names and local paths.

## External lookups

Ninety can use external IP/geo lookups for connection diagnostics and UI status. These lookups can be disabled in settings.

Disabling external lookups can make location or status information less complete, but it reduces extra network requests made by the app.

## Subscription refresh fallback

Subscription refresh is designed with a privacy-safe default: direct fallback is opt-in. If refresh through the active connection fails, Ninety should not silently retry directly unless the user enables that behavior.

This matters because subscription URLs are often credentials.

## Runtime configs

Runtime configs are generated on demand for the active source, mode and options. They can contain credentials needed by local engines.

Ninety cleans runtime configs after disconnect and purges stale runtime configs on startup. This cleanup reduces exposure, but it does not replace careful handling of local backups, logs or filesystem access.

## What Ninety does not promise

Ninety does not promise anonymity.

Ninety does not control:

- your server or subscription provider;
- upstream network behavior;
- Windows policy, firewall or endpoint security software;
- apps that bypass system proxy settings;
- mistakes in imported configs or routing rules.

An unsafe provider stays unsafe. A bad configuration can still leak traffic or break connectivity. Review your settings before enabling VPN · TUN, DPI tools or kill switch.

## Public issue safety

Public reports are useful, but they must be sanitized. Do not post:

- private subscription URLs;
- UUIDs, passwords or access tokens;
- private keys;
- WARP account/device data;
- full configs;
- real private server addresses;
- personally identifying paths or account names.

For security-sensitive findings, follow [SECURITY.md](../SECURITY.md).
