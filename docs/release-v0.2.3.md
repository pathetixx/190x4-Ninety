# Ninety v0.2.3

Ninety is a Kurogane-style Windows client for sing-box, WARP, TUN mode, routing rules and connection diagnostics.

This release focuses on import reliability, subscription refresh behavior, safer settings normalization and the new shared theme registry.

## Highlights

- **Subscription refresh is more predictable.** Background refresh now respects the auto-update switch of each subscription, while manual refresh still updates everything on demand.
- **Multi-link import is fixed.** Pasting several protocol links at once now imports them as a list instead of treating the whole paste as one malformed config.
- **Manual refresh intervals are preserved.** Server-provided headers no longer overwrite a manually chosen subscription interval.
- **Settings are safer.** Numeric settings now clamp invalid, empty, below-min and above-max values in JavaScript before they reach the runtime config.
- **Clearer refresh feedback.** Refresh-all now reports full success, partial failure and full failure separately.
- **Theme system polish.** Theme metadata now lives in a shared registry used by Settings and onboarding.
- **New themes.** Added Shiro Light, Sakura Haze, Midnight Indigo, Amber Glass, Glacier and Ronin Violet.
- **Cleaner surfaces.** CSS surfaces now use semantic overlay, shine and shadow tokens so light themes render cleanly.

## Download

Use the latest installer from the assets below:

- **`.exe` / NSIS installer** — recommended for most users.
- **`.msi` package** — useful for manual deployment or environments where MSI is preferred.

Requirements: **Windows 10 / 11 x64**.

## Before upgrading

Ninety keeps user settings, profiles and subscriptions across updates. Still, profiles and subscriptions may contain credentials, so treat exported configs and logs as sensitive.

If you use TUN mode, WARP, DPI tools or kill switch, disconnect before installing manually. In-app updates handle the normal stop/update/restore flow automatically.

## Security and privacy notes

- Default engine logs stay on `warn` to reduce the chance of writing visited domains to disk during normal use.
- Runtime configs are generated on demand and stale runtime configs are purged on startup.
- Imported subscriptions and profiles can contain credentials. Do not paste private configs, UUIDs, keys or subscription URLs into public issues.
- Subscription direct fallback remains opt-in.
- TUN mode, DPI tools and kill switch change Windows networking state. Review settings before enabling them.

For vulnerability reports and sensitive findings, see [SECURITY.md](./SECURITY.md).

## Good issue reports include

- Ninety version.
- Windows version.
- Installer type: NSIS `.exe`, MSI or development build.
- Connection mode: Proxy, System proxy, VPN · TUN or WARP-only.
- Source type: subscription, standalone profile or WARP-only.
- Sanitized logs/screenshots with credentials removed.

## Links

- README: https://github.com/pathetixx/190x4-Ninety#readme
- Changelog: https://github.com/pathetixx/190x4-Ninety/blob/main/CHANGELOG.md
- Security policy: https://github.com/pathetixx/190x4-Ninety/blob/main/SECURITY.md
