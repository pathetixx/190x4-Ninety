# Diagnostics

The Diagnostics screen answers one question: what exactly is broken — the network, the server, or the service on the other side. Every check runs from the machine Ninety is installed on, and nothing is sent anywhere.

## Reachability matrix

Each target is probed twice: directly and through the tunnel. A single probe proves nothing; the pair does.

| Direct | Through Ninety | Reading |
| --- | --- | --- |
| fails | works | the network blocks it, the tunnel helps |
| works | fails | the tunnel is in the way — usually a bank or a government site that refuses foreign addresses |
| fails | refused (4xx) | the service rejects the server's address |
| works | works | nothing to fix |

The target list has three layers: a global core that is the same everywhere, a country pack (banks, government and local services — those are the ones that break because of a tunnel), and addresses pinned by hand. The country pack is chosen on the screen and is independent of the routing `Region` setting.

When the kill switch or strict tunnel is on, the direct column is not probed at all and is marked as skipped rather than guessed.

## Manual check

Any address can be checked by hand: a domain, `host:port`, an IP, or a full URL. The result is broken into the stages a real connection goes through — DNS, TCP, TLS, HTTP — for both directions. Comparing the DNS answers is the point: a resolver that returns a placeholder while the tunnel returns the real address is a substitution, not a dead server.

A checked address can be pinned into the run set, or turned into a routing rule in one click.

## Trace

Two tracks over the same path:

- ICMP with a stepped TTL — which hops answer and how fast;
- TCP to the server port with the same TTL — whether the SYN gets any answer at all.

If hops keep answering ICMP while TCP goes silent from some hop onward, the connection is being killed there. If the silence starts at the last hop, the path is fine and the server itself is not answering on that port.

The trace is only meaningful outside the tunnel. ICMP goes through `IcmpSendEcho`, so no raw sockets and no administrator rights are needed.

## Leaks

Checks that run while the tunnel is up: whether names resolve inside the tunnel, whether the system resolver and the tunnel agree on an address, what the external address looks like from the internet, and whether IPv6 is reachable bypassing the tunnel. WebRTC is not checked here — it is a browser-level property and belongs to the protected browser.

## Timeline

A short history of connection incidents: what happened, what Ninety did about it, and how long it took. The quality engine, the watchdogs and the core write into it, so the work they already do stops being invisible. Entries are stored locally, capped, and expire after two weeks.

## Report

“Copy report” produces a plain-text summary with IP addresses masked. It is meant to be pasted into a support chat instead of raw logs.
