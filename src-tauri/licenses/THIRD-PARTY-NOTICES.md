# Third-party notices

Ninety itself is MIT-licensed (see [`LICENSE`](../../LICENSE)). The installer also
carries third-party executables, libraries and drivers that keep their own
licenses. This file lists every one of them, and the full license texts sit next
to it — in the repository under `src-tauri/licenses/`, and in the installed
application under `licenses\` next to `Ninety.exe`.

Each engine runs as a separate process that Ninety starts and controls over a
local API. Shipping them together is aggregation, not linking: their licenses
apply to those files, and Ninety's own source stays under MIT.

Versions below are the ones pinned in
[`.github/workflows/build.yml`](../../.github/workflows/build.yml) for this
release line; the workflow is the authoritative source and verifies every
download by commit SHA or SHA-256.

---

## sing-box — `sing-box.exe`

The primary networking engine.

| | |
| --- | --- |
| Version | `v1.13.19-ninety.4` (commit `505a658b77ba7208da17a9f848c3641a897bfeee`) |
| Source | <https://github.com/pathetixx/ninety-core> |
| Upstream | <https://github.com/SagerNet/sing-box> |
| License | GNU General Public License v3.0 or later, with an additional naming clause |
| Texts | [`sing-box.txt`](./sing-box.txt) (upstream notice), [`GPL-3.0.txt`](./GPL-3.0.txt) (full license) |

`ninety-core` is a fork of SagerNet/sing-box carrying the patches Ninety needs.
It is public, and the complete corresponding source of the binary in this
installer is the tree at the tag and commit above. CI builds the binary from
that source; nothing is added at bundle time.

The upstream notice adds: "no derivative work may use the name or imply
association with this application without prior consent." Ninety ships under its
own name and claims no association with the sing-box project.

## Xray-core — `xray.exe`

The engine used for XHTTP connections.

| | |
| --- | --- |
| Version | `v26.7.28` (commit `5ca6f4b7d4dc20a881d4330e498892697627ec0c`) |
| Source | <https://github.com/XTLS/Xray-core> |
| License | Mozilla Public License 2.0 |
| Text | [`xray-core.txt`](./xray-core.txt) |

Built from unmodified upstream source at the tag and commit above. The source
form of this Covered Software is available from the repository under the same
license.

## NaiveProxy — `naive.exe`

Local SOCKS bridge for `naive+https://` nodes.

| | |
| --- | --- |
| Version | `v148.0.7778.96-5` |
| Source | <https://github.com/klzgrad/naiveproxy> |
| License | BSD 3-Clause (Chromium) |
| Text | [`naiveproxy.txt`](./naiveproxy.txt) |

Redistributed as the unmodified official release binary, verified by SHA-256.
The binary is built on the Chromium networking stack; upstream publishes its
license terms in the repository above.

## TrustTunnel Client — `trusttunnel_client.exe`

Local SOCKS bridge for `tt://` endpoints.

| | |
| --- | --- |
| Version | `v1.0.49` |
| Source | <https://github.com/TrustTunnel/TrustTunnelClient> |
| License | Apache License 2.0 |
| Text | [`trusttunnel-client.txt`](./trusttunnel-client.txt) |

Redistributed as the unmodified official release binary, verified by SHA-256.

## Wintun — `wintun.dll`

Virtual network adapter used by the engine in VPN · TUN mode.

| | |
| --- | --- |
| Version | `0.14.1` |
| Source | <https://www.wintun.net/> (source: <https://git.zx2c4.com/wintun/>) |
| License | Wintun Prebuilt Binaries License (WireGuard LLC) |
| Text | [`wintun.txt`](./wintun.txt) |

The signed DLL from wintun.net is the only supported distribution form, and it
is redistributed here unmodified, verified by SHA-256. Its license permits
redistribution alongside software that uses Wintun through the documented API,
which is how the engine uses it.

## zapret / winws — `dpi\bin\winws.exe`, `dpi\bin-monkey\winws.exe`, strategies and domain lists

The DPI-bypass engine and its data.

| | |
| --- | --- |
| Version | engine `zapret v72.12`, strategy set `1.10.0` |
| Source | <https://github.com/bol-van/zapret>, packaging by <https://github.com/Flowseal/zapret-discord-youtube> |
| License | MIT |
| Text | [`zapret-winws.txt`](./zapret-winws.txt) |

## WinDivert — `dpi\bin\WinDivert.dll`, `dpi\bin\WinDivert64.sys`, `dpi\bin-monkey\WinDivert.dll`, `dpi\bin-monkey\Monkey64.sys`

Packet-capture library and kernel driver the bypass engine builds on.

| | |
| --- | --- |
| Source | <https://github.com/basil00/WinDivert> |
| License | GNU Lesser General Public License v3.0 **or** GNU General Public License v2.0, at your option |
| Texts | [`windivert.txt`](./windivert.txt) (contains LGPLv3, GPLv3 and GPLv2 in full) |

The copies in `dpi\bin\` are unmodified.

The copies in `dpi\bin-monkey\` are modified, and the modification is ours:
`WinDivert.dll` there has its service and driver-file name strings changed
(`WinDivert` → `Monkey`), and `Monkey64.sys` is a byte-identical copy of
`WinDivert64.sys` under a different file name. This exists so the driver does not
load under a widely filtered name; the code paths are unchanged. Both files stay
under the license above. `winws.exe` loads the DLL by name from its own
directory, so either copy can be replaced with a build of your own from the
upstream source.

## Cygwin runtime — `dpi\bin\cygwin1.dll`, `dpi\bin-monkey\cygwin1.dll`

Runtime the zapret engine binaries are built against.

| | |
| --- | --- |
| Source | <https://cygwin.com/git/?p=newlib-cygwin.git> |
| License | GNU Lesser General Public License v3.0 or later, with the Cygwin Linking Exception |
| Texts | [`cygwin.txt`](./cygwin.txt), [`LGPL-3.0.txt`](./LGPL-3.0.txt), [`GPL-3.0.txt`](./GPL-3.0.txt) |

Redistributed unmodified.

---

## Getting the source

For every component above, the corresponding source is available from the
upstream location listed with it, at the pinned version. If a link ever stops
resolving, open an issue at
<https://github.com/pathetixx/190x4-Ninety/issues> and the source archive for
that release will be provided.
