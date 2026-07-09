# Troubleshooting

Start with the **Logs** screen. It is the main place to diagnose imports, engine startup, bridges, routing, WARP, updater state and cleanup.

Do not post private subscription URLs, UUIDs, passwords, tokens, private keys, WARP account/device data or full configs in public issues.

## Before opening an issue

1. Update to the latest release from GitHub Releases.
2. Reproduce with the smallest setup you can: one source, one mode, one changed setting.
3. Check the **Logs** screen.
4. Sanitize logs and screenshots.
5. Include Ninety version, Windows version, install type, mode and source type.

Useful report template:

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

## App does not start

- Try launching from the Start menu again after a few seconds.
- Check whether antivirus or endpoint security blocked the executable.
- If this happened after an update, install the latest `.exe` or `.msi` from Releases.
- Include Windows version and install type in the issue.

## Installer or update problems

- Prefer the latest `.exe` installer for normal desktop installation.
- Use MSI only when your environment needs MSI deployment.
- Disconnect before manually installing over an active TUN/WARP session.
- If the in-app updater fails, check whether your current network blocks GitHub or the configured update endpoint.
- Do not edit release `latest.json` locally or ask users to replace it manually.

## Import does not work

- Check whether the source is a subscription URL, standalone profile link or TrustTunnel `.toml` endpoint file.
- Try importing one link first before pasting a multi-link list.
- Remove unrelated text around the link.
- Do not share the real subscription URL publicly. Replace hostnames, IDs and credentials with placeholders.

## Subscription refresh fails

- Confirm the subscription URL still works outside Ninety without exposing it publicly.
- Check whether refresh is enabled for that subscription.
- If connected, try refreshing once while connected and once after disconnecting.
- Direct fallback is opt-in. If it is disabled, Ninety should not silently retry subscription refresh directly.
- Attach sanitized Logs output.

## Connected but no internet

- Identify the mode: Proxy, System proxy, VPN · TUN or WARP-only.
- In Proxy mode, verify the app/browser is configured to use Ninety's local proxy.
- In System proxy mode, check whether the affected app respects Windows proxy settings.
- In VPN · TUN mode, check DNS, routing rules, kill switch and other VPN clients.
- Try a different node or WARP endpoint if available.
- Check **Logs** for engine startup, bridge and DNS messages.

## System proxy was not restored

- Disconnect from Ninety if it is still connected.
- Check Windows proxy settings manually.
- Look for restore or cleanup messages in **Logs**.
- Mention whether another proxy/VPN tool was running at the same time.

## TUN mode fails or UAC was cancelled

- TUN requires elevation. If UAC is cancelled, the mode cannot start.
- Switch back to Proxy or System proxy before retrying.
- Check whether another VPN client, firewall or endpoint security product is active.
- Include the exact point where elevation failed and sanitized Logs output.

## WARP registration or scan issues

- Check **Settings -> WARP** first.
- Confirm WARP is registered before testing WARP-only mode.
- Endpoint scans can fail on restricted, unstable or captive networks.
- Do not post WARP keys, account IDs, device data or backup state publicly.

## DNS issues

- Try a minimal setup without custom routing rules.
- Check whether DNS differs between Proxy/System proxy and VPN · TUN mode.
- If only one app fails, it may be bypassing the Windows proxy or using its own DNS behavior.
- Include the selected mode and sanitized Logs output.

## Routing rules behave unexpectedly

- Disable custom rules and retest with defaults.
- Re-enable one rule at a time.
- Check rule type: domain, IP/subnet or process.
- Check action: through VPN, direct or block.
- TUN mode can apply routing differently from Proxy/System proxy because traffic enters the engine differently.
- Use the connections monitor to confirm which process or destination is actually active.

## DPI tools fail to start or stop

- Revert recent DPI tool changes and reconnect.
- Avoid changing DPI tools, TUN mode and kill switch at the same time while debugging.
- Driver cleanup may require reconnecting or restarting the app.
- Public reports should describe the symptom and state, not detailed bypass instructions.

## Kill switch blocks traffic

- Disable kill switch if the UI is reachable.
- Disconnect and reconnect using System proxy or Proxy mode first.
- Check whether another firewall or endpoint security product is managing similar rules.
- Include sanitized Logs output and the active mode.

## Logs to collect

Useful logs are:

- import or subscription errors;
- engine startup and shutdown messages;
- bridge startup errors for xray, NaiveProxy or TrustTunnel;
- WARP registration or scan messages;
- routing and DNS warnings;
- update errors.

Before sharing logs publicly, remove:

- subscription URLs;
- UUIDs, passwords and access tokens;
- private keys;
- WARP account/device data;
- real private server addresses;
- personally identifying paths or account names.
