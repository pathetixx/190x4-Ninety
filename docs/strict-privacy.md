# Strict tunnel and protected browser

Ninety's privacy features reduce accidental traffic and browser-fingerprint
leaks. They do not make a VPN exit address indistinguishable from a residential
connection, and they are not a promise of anonymity.

For general information about local data and external requests, see
[Privacy and local data](privacy.md).

## Strict tunnel

Strict tunnel is a runtime policy layered over the user's saved settings. It
does not permanently rewrite unrelated preferences. While enabled, the runtime
configuration:

- forces `VPN · TUN` mode with strict routing;
- pins the connection to one explicitly selected server;
- disables automatic server failover and requires the selected server to remain
  available;
- sends destination DNS through the remote resolver inside the tunnel and uses
  an IP-hosted encrypted DoH resolver only to bootstrap the selected VPN
  server's own hostname;
- disables direct routing exceptions, regional bypasses, custom direct rules
  and LAN bypass;
- disables IPv6 routing to avoid an unprotected parallel path;
- disables WARP, WARP endpoint rotation and automatic connection-quality
  recovery, because those features can change the effective path or server.

If no concrete server is selected, or that server is no longer present, the
connection fails closed instead of silently falling back to another server or
to a direct route. The normal saved options become effective again when strict
tunnel is disabled.

This policy prioritizes path stability and leak prevention over reachability.
Local devices and services may be unavailable while it is active.

## Session fail-closed firewall

On Windows, strict tunnel also arms a Windows Filtering Platform (WFP) policy.
The policy permits the tunnel processes and traffic bound to Ninety's TUN
interface, then blocks other outbound connections. If the VPN core
dies or the TUN interface disappears while Ninety is still running, the block
remains in place during recovery so applications cannot silently fall back to
the physical network.

This is a **session-scoped** safety mechanism, not a permanent Windows firewall
configuration:

- it requires administrator rights;
- its WFP session is dynamic and is removed by Windows when the Ninety process
  exits or crashes;
- Ninety verifies the critical filters every five seconds and atomically
  recreates them if Windows Filtering Platform has restarted;
- quitting Ninety therefore removes the block even if the VPN tunnel was lost;
- a user-requested disconnect also releases the session block;
- third-party firewalls, endpoint-security products or Windows networking
  changes can still affect the result.

A restart of the Windows Base Filtering Engine removes dynamic filters before
Ninety can observe it. Automatic re-arming narrows this unavoidable interval,
but cannot make it zero without a separate persistent privileged Windows
service.

Keeping a permanent firewall block after an application exits could leave the
computer offline without a reliable in-app recovery path. Ninety deliberately
uses the dynamic session boundary instead.

The VPN engine may still resolve or contact the selected server outside the
TUN interface because that is required to bootstrap the tunnel. The WFP policy
allows only the known engine binaries for this purpose; ordinary applications
and the Ninety controller are not granted that direct path.

Some protocols use a separate bridge client whose resolver cannot be forced by
Ninety. Strict tunnel rejects those nodes when their endpoint is hostname-only
instead of silently allowing system DNS. XHTTP and Naive nodes need an IP server
address; TrustTunnel needs IP entries in its `addresses` list. This restriction
applies only to strict tunnel.

## Mullvad Browser integration

[Mullvad Browser](https://mullvad.net/browser) is free and open-source. It does
not require a Mullvad VPN subscription and can be used with Ninety or another
VPN provider.

Ninety detects an existing Windows installation and can:

- open a protected browsing session after `VPN · TUN` is connected;
- open Mullvad's browser-check page in that session;
- optionally launch one session after a successful Ninety connection;
- open the official download page when the browser is not installed.

Launch and download actions require an active `VPN · TUN` connection. A plain
local proxy does not guarantee that an unconfigured browser will use Ninety.
Mullvad Browser remains a separate application: disconnecting or quitting
Ninety does not close an already open browser. Close protected browsing sessions
before releasing the tunnel, otherwise their next requests can use the ordinary
system connection.

Ninety does not silently install the browser and does not embed a custom
anti-detect WebView. Mullvad Browser is useful because users share a deliberately
standardized browser configuration. Randomizing many fingerprint values would
often make a browser more unique or internally inconsistent.

## What these features cannot hide

The public exit IP is still the VPN server's IP. Browser fingerprint protection
cannot change it.

Websites commonly use commercial and internal reputation data to classify:

- datacenter and hosting ASNs;
- public VPN and proxy address ranges;
- addresses with abuse or automation history;
- unusually high account or request volume from one shared exit.

Strict tunnel cannot remove those labels, and Mullvad Browser cannot make a
datacenter IP residential. If a site rejects the exit address, selecting a
different VPN server may help, but there is no reliable client-side switch that
can guarantee acceptance. Account history, cookies, authentication behavior and
the site's own rules can also affect access.

Use these features to reduce leaks and browser uniqueness, not to bypass a
site's access controls or to assume that the site cannot identify VPN usage.
