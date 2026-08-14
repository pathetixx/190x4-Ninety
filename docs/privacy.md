# Privacy and local data

Ninety is a local Windows networking client. It does not run a hosted VPN service, and it does not make a server or provider trustworthy by itself.

## No telemetry or project-operated collection

Ninety does not include advertising, usage analytics, crash-report uploads or a
project-operated account/telemetry service. The Ninety project does not receive
copies of profiles, subscription contents, browsing history or connection logs
from the application.

Like any networking client, Ninety still makes outbound requests when required
by a feature. The destination service can observe the public IP address and
normal connection metadata. Those operational requests are described below.

## Network requests

Depending on the features the user enables, Ninety may contact:

- servers, subscriptions and DNS resolvers explicitly configured by the user;
- GitHub and GitLab to check for and download Ninety updates;
- GitHub-hosted release channels or upstream repositories to retrieve signed or
  pinned DPI data and routing rule sets;
- public connectivity and download-test endpoints, including Google and
  Cloudflare endpoints, to measure reachability, latency and throughput;
- Discord, Discord's CDN and YouTube (`discord.com/api`, `cdn.discordapp.com`,
  `www.youtube.com`) while the DPI auto-pick is running: it verifies that a
  candidate strategy actually opens these services. These probes deliberately
  bypass the tunnel — the DPI engine works on the real interface — so they are
  made from the user's own address. Auto-pick runs only when started manually
  from the DPI screen;
- public IP/geo services (`ipwho.is`, `api.ip.sb` and `ipapi.co`) to show the
  current public IP, country and network provider when geo lookups are enabled;
- Cloudflare's WARP API and WARP endpoints when the user registers or connects
  a WARP profile.

Subscription credentials are sent only to the subscription endpoint entered by
the user. Connection profile credentials are passed to the selected local
network engines so they can connect to the configured server. Public test,
update and geo services are not intentionally sent profile contents or logs.

Geo lookups can be disabled in Settings. Subscription refresh, WARP
registration, DPI data updates and connection tests occur only when their
corresponding features are configured or used. Update checks are required for
the built-in updater, but installing an offered update remains a user action.

## Third-party services

Requests to a user-configured server, subscription or DNS resolver are governed
by that provider's privacy policy. Other service policies relevant to built-in
features include:

- [GitHub Privacy Statement](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement)
  for releases, update fallback and hosted rule data;
- [GitLab Privacy Statement](https://about.gitlab.com/privacy/)
  for the primary updater mirror;
- [Cloudflare Privacy Policy](https://www.cloudflare.com/privacypolicy/)
  for WARP, connectivity and download tests;
- [Google Privacy Policy](https://policies.google.com/privacy)
  for optional connectivity tests;
- the published terms or privacy notices of
  [ipwho.is](https://ipwho.is/), [IP.SB](https://ip.sb/) and
  [ipapi.co](https://ipapi.co/) for optional public IP/geo lookups.

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
