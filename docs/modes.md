# Connection modes and safety notes

Ninety is a Windows networking client. The selected mode changes how traffic enters the local engines and how much Windows networking state the app has to touch.

Ninety does not make a provider, server or configuration safe by itself. Treat imported profiles, subscriptions and logs as sensitive data.

## Proxy

Proxy mode starts local proxy listeners on `127.0.0.1`. Apps that support SOCKS or HTTP proxy settings can be pointed at Ninety manually.

Use it when:

- you want the smallest system impact;
- you only need selected apps to use Ninety;
- you are testing a profile or subscription without changing Windows proxy settings.

Admin rights: not normally required.

What can break:

- apps that are not configured to use the local proxy will keep using the network directly;
- browser or app proxy settings can point to the wrong local port;
- DNS behavior depends on the app and the selected profile.

Diagnostics: open the **Logs** screen and check startup, import, bridge and connection messages.

## System proxy

System proxy mode configures the Windows user-level system proxy to point at Ninety's local proxy. This is the recommended default for many desktop users.

Use it when:

- you want browsers and many desktop apps to follow the Windows proxy setting;
- you do not want full TUN routing;
- you want a default that usually does not require elevation.

Admin rights: not normally required.

What can break:

- some apps ignore the Windows system proxy;
- a crash or external tool can leave Windows proxy state different from what you expect;
- a proxy auto-config (PAC) script or automatic proxy detection set in Windows takes priority over the manual proxy in many browsers;
- dial-up, PPPoE and Windows VPN connections keep their own proxy settings: Ninety sets the proxy for the regular network connection only;
- corporate, school or managed Windows policy can override proxy settings.

Diagnostics: open **Logs**, then verify Windows proxy settings if traffic does not recover after disconnect.

## VPN · TUN

VPN · TUN mode routes system traffic through a TUN interface. This mode changes more Windows networking state than Proxy or System proxy mode.

Use it when:

- you need apps that do not support proxy settings to use the tunnel;
- you need routing rules to apply closer to system traffic;
- you understand that elevation and driver/runtime components may be involved.

Admin rights: required. Ninety may ask for UAC elevation when entering or restoring TUN mode.

What can break:

- UAC cancellation prevents TUN from starting;
- driver, firewall, antivirus or endpoint security software can block TUN setup;
- routing, DNS or kill switch settings can make traffic look offline;
- another VPN client can conflict with the TUN interface or routes.

Diagnostics: open **Logs** first. If TUN was cancelled at UAC, switch back to Proxy or System proxy and retry only after checking the selected settings.

## WARP-only

WARP-only mode can run without a normal profile or subscription when WARP is registered and enabled in settings. Ninety builds the runtime route around the WARP/WireGuard state.

Use it when:

- you want to test WARP without importing a subscription;
- you need a clean baseline before adding profiles or routing rules;
- you are debugging WARP registration or endpoint scanning.

Admin rights: depends on the selected connection mode. WARP-only with VPN · TUN still requires elevation.

What can break:

- WARP must be registered before it can be used;
- endpoint scans can fail on restricted or unstable networks;
- changing WARP settings while connected may require a reconnect.

Diagnostics: check **Settings -> WARP** and the **Logs** screen. Do not post WARP account, device or key material publicly.

## DPI tools

DPI tools are separate compatibility tools for specific network conditions. They can update strategy/list data, manage runtime helper state and clean up driver state.

Use them only when:

- normal Proxy, System proxy or VPN · TUN mode does not behave correctly on the current network;
- you can test carefully and revert the setting if it makes the connection worse.

Admin rights: may be required depending on the selected action and driver state.

### Custom strategies

**Strategies → Custom strategy** saves up to three strategies of your own, in the same format as the built-in ones: a name, a description, an experimental flag and the winws arguments split into sections by `--new`.

- **Base** copies the sections of a built-in strategy into the editor. Change only the sections you need: winws takes the first matching section from the top, and the rest keep working as in the base. A changed section is marked, and it can be restored from the base.
- **Full text** edits the whole strategy at once. It accepts winws parameters, a line copied from a zapret `.bat` file, or JSON in the built-in format (`name`, `desc`, `experimental`, `args`). **Import** reads such a file and recognises the built-in strategy it was made from; **To file** and **Copy JSON** export the strategy in the same format.
- `--wf-tcp`/`--wf-udp` interception is assembled from the section filters, so a section on a new port gets its packets. Explicit `--wf-*` ports are kept only where filters can't imply them (`*` or negated filters).
- Fake payloads are referenced by file name, for example `@tls_clienthello_max_ru.bin`; only files from the strategy set are available. Lists are limited to the app's own list files.
- Options that write or read arbitrary files or replace the WinDivert filter (`--debug`, `--wf-raw`, `--pidfile`, `--hostlist-auto` and similar) are rejected: winws runs with administrator rights.
- The paths, the game filter, the **Where the bypass applies** setting and the active VPN server exclusion are applied to a custom strategy exactly as to a built-in one.
- The editor checks the parameters as you type and shows the final winws command. **Check with winws** runs `winws --dry-run` with that command; it needs administrator rights, otherwise the parameters are checked at launch. Custom strategies are not part of automatic strategy selection.

**Exclusions** accept domains, IP addresses and subnets. Addresses go to a separate IP list, because winws matches the domain list by host name only.

What can break:

- helper tools can fail to start or stop cleanly;
- driver cleanup can affect active networking until you reconnect;
- combining DPI tools with TUN mode can be confusing if you change several settings at once.

Diagnostics: open the DPI screen and **Logs**. Public bug reports should describe the symptom and selected app mode, not detailed operational bypass recipes.

## Kill switch

Kill switch is designed to block traffic when Ninety cannot keep the intended protected state. It uses Windows networking controls and should be treated as a safety feature with real system impact.

Use it when:

- you understand how to recover if traffic is blocked;
- you have tested your selected mode and routing rules first;
- you need stricter behavior on disconnect or failure.

Admin rights: may be required because the feature touches Windows filtering state.

What can break:

- traffic can remain blocked if the app is interrupted during a state change;
- another firewall or security product can conflict with the rules;
- Proxy mode expectations can differ from TUN mode expectations;
- NaiveProxy and TrustTunnel servers set by a domain name resolve it through the Windows DNS client, which the kill switch blocks. Use a server with an IP address, or keep LAN bypass on with the router as the DNS server. XHTTP and mKCP servers resolve their address through the direct DNS from settings when it is set by an IP address.

Diagnostics: open **Logs**, disable kill switch from settings if possible, and reconnect. If traffic is still blocked, include sanitized logs in a bug report.

## What to include in reports

When opening an issue, include:

- Ninety version;
- Windows version;
- install type: NSIS `.exe`, MSI or development build;
- connection mode;
- source type: subscription, standalone profile or WARP-only;
- sanitized logs or screenshots.

Do not post subscription URLs, UUIDs, passwords, tokens, private keys, WARP account/device data or full configs publicly.
