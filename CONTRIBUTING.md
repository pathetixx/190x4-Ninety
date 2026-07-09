# Contributing to Ninety

Thanks for taking the time to improve Ninety. The project is still moving quickly, so the most useful contributions are reproducible bug reports, careful fixes, tests, docs and small focused pull requests.

## Before opening an issue

1. Install the latest release.
2. Check the [Changelog](./CHANGELOG.md) for recent fixes.
3. Search existing issues and discussions.
4. Try to reproduce with a minimal setup.

Do **not** paste private subscription links, access tokens, UUIDs, passwords, private keys, WARP registration data or full exported configs into public issues.

## Good bug reports

A good bug report should include:

```text
Ninety version:
Windows version:
Install type: MSI / NSIS / dev
Connection mode: Proxy / System proxy / VPN · TUN
Source type: subscription / standalone profile / WARP-only
Protocol/transport, if relevant:
Steps to reproduce:
Expected result:
Actual result:
Sanitized logs/screenshots:
```

For connection issues, the **Logs** screen is usually more helpful than a generic description. Please sanitize logs before sharing them publicly.

## Pull request style

Keep PRs focused. A small PR with one clear fix is much easier to review than a mixed feature/refactor/style change.

Prefer:

- one bug fix per PR;
- tests for parser/config-builder/routing logic when possible;
- clear before/after behavior in the PR description;
- no unrelated formatting churn;
- no private endpoints, test accounts or real subscription data in fixtures.

## Development setup

Requirements:

- Node.js 18 or newer;
- Rust stable;
- MSVC build tools;
- Windows for full Tauri builds and Windows API behavior.

Install JavaScript dependencies:

```powershell
npm install
```

Run frontend checks:

```powershell
npm run lint
npm test
```

Run the app in development:

```powershell
npm run tauri dev
```

Build release artifacts:

```powershell
npm run tauri build
```

External engines (`sing-box`, `xray-core`, NaiveProxy, TrustTunnel) and `wintun.dll` are prepared by CI and are not stored in the repository.

## Testing notes

The project currently has JavaScript tests for parsing, config building, routing rules, subscriptions, settings and UI logic. Add tests when changing:

- protocol link parsers;
- URL helpers;
- subscription parsing/refresh behavior;
- sing-box config generation;
- routing rules;
- restart policy;
- quality engine decisions;
- settings normalization.

Rust/Tauri checks are heavier and are expected to run in the Windows GitHub Actions pipeline unless your local environment is fully prepared for them.

## Security and privacy expectations

Ninety manages networking state and user credentials. Changes should preserve privacy-safe defaults:

- no verbose connection-domain logging by default;
- no direct fallback for sensitive network requests unless the user explicitly opts in;
- no public issue templates that encourage sharing secrets;
- imported data must be escaped before rendering into HTML;
- temporary runtime configs with credentials must be cleaned up;
- control APIs should remain loopback-only;
- destructive actions should require explicit confirmation.

For security-sensitive reports, see [SECURITY.md](./SECURITY.md).

## Documentation

Docs should be written for real users first and developers second. Prefer clear explanations of behavior, limitations and troubleshooting steps over marketing language.

When adding a feature, update at least one of:

- [README.md](./README.md);
- [README.ru.md](./README.ru.md);
- [CHANGELOG.md](./CHANGELOG.md);
- in-app i18n strings.
