# Routing

Ninety builds routing rules for sing-box from the selected mode, source and settings. Routing decides whether traffic should go through the selected VPN path, go direct or be blocked.

This document explains the logic at a user and diagnostics level. It is not an operational guide for bypassing network controls.

## Core actions

Routing rules generally resolve to one of three actions:

- **Through VPN**: send matching traffic through the selected proxy, tunnel or WARP path.
- **Direct**: send matching traffic outside the selected VPN path.
- **Block**: reject matching traffic.

The visible labels in the app may be localized, but the behavior maps to these three outcomes.

## LAN bypass

LAN bypass keeps local network destinations reachable directly. This is useful for routers, printers, NAS devices, local development servers and other private network resources.

If a local device is not reachable while connected, check whether LAN bypass is enabled and whether the destination is really in a private/local range.

## Regional and built-in rules

Ninety can apply built-in regional and safety-oriented rule sets, such as LAN, regional defaults and selected ad/malware/phishing lists.

These rules are meant to provide practical defaults. If behavior is surprising, disable optional rule sets one at a time and retest.

## Custom rules

Custom rules can match:

- domains;
- IP addresses or subnets;
- process names.

Each custom rule has an action: through VPN, direct, block, through a specific server or through WARP. Custom rules are intended to be evaluated before broad defaults so user intent can override regional defaults.

A rule that targets a specific server stores the identity of that server, so reordering a subscription does not break it. If the server is gone from the active source, quarantined, or excluded because strict tunnel pins a single node, the rule falls back to the regular tunnel instead of pointing at an outbound that no longer exists.

Safe debugging pattern:

1. Disable custom rules.
2. Confirm the baseline works.
3. Re-enable one rule.
4. Test again.
5. Repeat until the unexpected rule is found.

Do not include private domains, private IP ranges or internal process names in public screenshots unless they are sanitized.

## DNS relation

DNS behavior depends on the selected mode and generated config. A domain rule can only work as expected if the destination is visible to the routing layer in a form the rule can match.

If DNS behavior looks wrong:

- compare Proxy/System proxy and VPN · TUN mode;
- check whether the app uses its own DNS behavior;
- test without custom DNS-related settings;
- collect sanitized Logs output.

## Proxy and System proxy modes

In Proxy mode, only apps configured to use Ninety's local proxy enter the routing pipeline.

In System proxy mode, apps that respect the Windows system proxy enter the routing pipeline. Apps that ignore Windows proxy settings may still connect directly.

If a rule appears ignored in these modes, first confirm that the app traffic is actually using Ninety.

## VPN · TUN mode

In VPN · TUN mode, traffic enters through a TUN interface and routing applies closer to system traffic. This can cover apps that do not support proxy settings, but it also touches more Windows networking state.

TUN mode can be affected by:

- UAC elevation;
- other VPN clients;
- firewall or endpoint security tools;
- DNS settings;
- kill switch rules;
- process-name matching differences.

When debugging TUN routing, start with a minimal config and add custom rules gradually.

## WARP routing

When WARP is enabled, some generated routes can use the WARP/WireGuard path. WARP-only mode can work without a normal profile or subscription after WARP registration.

Do not post WARP keys, account/device data or raw state files publicly.

## Connection monitor

The connections view is useful for confirming what is active while connected. Use it to compare expected rules with actual traffic.

If the monitor shows unexpected traffic:

- check the process name;
- check destination domain or IP;
- check which mode is active;
- temporarily disable broad custom rules;
- attach sanitized screenshots or logs to the issue.

## Safe troubleshooting checklist

- Start from System proxy mode unless the issue is TUN-specific.
- Disable custom rules and optional lists.
- Test one profile or subscription source.
- Re-enable rules one at a time.
- Check **Logs** after each failed start or reconnect.
- Sanitize all logs and screenshots before posting publicly.
