# Feedback, roadmap and known issues

This issue collects early feedback after the first public posts about Ninety.

Ninety is a Kurogane-style Windows client for sing-box, WARP, TUN mode, routing rules and connection diagnostics. The project is moving quickly, so focused reports and reproducible cases are more useful than broad feature requests.

## What feedback is most useful right now

- First-run onboarding problems.
- Import problems with subscriptions, standalone links or TrustTunnel `.toml` endpoints.
- Connection start/stop issues in Proxy, System proxy or VPN · TUN mode.
- Cases where Windows system proxy is not restored correctly.
- WARP registration, endpoint scan or WARP-only mode problems.
- Routing rules that generate unexpected behavior.
- DPI tools that fail to start/stop cleanly.
- Kill switch behavior that is confusing or unsafe.
- Logs/diagnostics that are not clear enough to understand a failure.
- UI/theme/localization issues, especially with light themes and RTL languages.

## Short-term roadmap

- Polish first-run onboarding and import hints.
- Improve failed-start diagnostics and user-facing recovery steps.
- Improve WARP endpoint scanning UX and status messages.
- Make tray server switching easier to understand.
- Expand documentation for routing rules and connection modes.
- Add a troubleshooting guide for common Windows networking states.
- Prepare English launch materials for broader feedback.
- Keep adding parser/config-builder tests for every import edge case.

## Known limitations

- Windows-only for now.
- Full Tauri builds require a Windows environment with MSVC tools.
- VPN · TUN requires elevation.
- TUN mode, DPI tools and kill switch change Windows networking state. Review settings before enabling them.
- Imported configs and subscriptions may contain credentials. Do not share them publicly.
- Some external engines are prepared by CI and are not stored directly in the repository.

## How to report a bug

Please include:

```text
Ninety version:
Windows version:
Install type: NSIS .exe / MSI / dev build
Connection mode: Proxy / System proxy / VPN · TUN / WARP-only
Source type: subscription / standalone profile / WARP-only
Protocol/transport, if relevant:
Steps to reproduce:
Expected result:
Actual result:
Sanitized logs or screenshots:
```

## Do not post secrets

Before sharing logs or screenshots, remove:

- subscription URLs;
- access tokens;
- UUIDs and passwords;
- private keys;
- WARP account/device data;
- real private server addresses;
- personally identifying paths or account names.

Security-sensitive reports should follow the repository security policy instead of being posted publicly: `SECURITY.md`.

## Useful links

- README: https://github.com/pathetixx/190x4-Ninety#readme
- Releases: https://github.com/pathetixx/190x4-Ninety/releases
- Changelog: https://github.com/pathetixx/190x4-Ninety/blob/main/CHANGELOG.md
- Security policy: https://github.com/pathetixx/190x4-Ninety/blob/main/SECURITY.md
