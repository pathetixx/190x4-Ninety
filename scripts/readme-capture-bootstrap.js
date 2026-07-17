// CI-only entrypoint copied into src/ by readme-screenshots.yml before build.
// Production packages never contain this file. It renders the real frontend in the
// real Tauri/WebView2 window with sanitized deterministic backend fixtures.

const tauri = window.__TAURI__;
const realInvoke = tauri?.core?.invoke?.bind(tauri.core);

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function waitFor(fn, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if (fn()) return; } catch {}
    await sleep(100);
  }
  throw new Error("README capture UI readiness timeout");
}

function base36(value) {
  return (value >>> 0).toString(36);
}

function stableHash(value) {
  let a = 0x811c9dc5;
  let b = 0x9e3779b9;
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x85ebca6b);
  }
  return `${base36(a)}${base36(b)}`;
}

const nodes = [
  { stableId: "demo-de-frankfurt", name: "🇩🇪 Frankfurt · Reality", host: "de-fra.demo.invalid", port: 443, proto: "vless", type: "tcp", security: "reality", uuid: "00000000-0000-4000-8000-000000000001", sni: "www.microsoft.com", pbk: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", sid: "01" },
  { stableId: "demo-nl-amsterdam", name: "🇳🇱 Amsterdam · XHTTP", host: "nl-ams.demo.invalid", port: 443, proto: "vless", type: "xhttp", security: "tls", uuid: "00000000-0000-4000-8000-000000000002", sni: "www.cloudflare.com", path: "/demo", mode: "auto" },
  { stableId: "demo-fi-helsinki", name: "🇫🇮 Helsinki · Hysteria2", host: "fi-hel.demo.invalid", port: 443, proto: "hysteria2", security: "tls", password: "demo-only", sni: "www.apple.com" },
  { stableId: "demo-ch-zurich", name: "🇨🇭 Zurich · Trojan", host: "ch-zrh.demo.invalid", port: 443, proto: "trojan", type: "grpc", security: "tls", password: "demo-only", sni: "www.google.com", serviceName: "demo" },
  { stableId: "demo-pl-warsaw", name: "🇵🇱 Warsaw · VLESS", host: "pl-waw.demo.invalid", port: 8443, proto: "vless", type: "ws", security: "tls", uuid: "00000000-0000-4000-8000-000000000005", sni: "www.github.com", path: "/ws" },
  { stableId: "demo-jp-tokyo", name: "🇯🇵 Tokyo · TUIC", host: "jp-tyo.demo.invalid", port: 443, proto: "tuic", security: "tls", uuid: "00000000-0000-4000-8000-000000000006", password: "demo-only", sni: "www.amazon.com" },
];

const nodeTags = nodes.map(node => `node-${stableHash(`node:${node.stableId}`)}`);
const delays = [34, 46, 58, 71, 92, 138];

function clashPayload() {
  const proxies = {
    proxy: { type: "Selector", now: "auto", all: ["auto", "lowest", ...nodeTags], history: [] },
    auto: { type: "Balancer", now: nodeTags[0], all: nodeTags, history: [{ time: "2026-07-17T08:00:00Z", delay: delays[0] }] },
    lowest: { type: "URLTest", now: nodeTags[0], all: nodeTags, history: [{ time: "2026-07-17T08:00:00Z", delay: delays[0] }] },
  };
  nodeTags.forEach((tag, i) => {
    proxies[tag] = { type: "VLESS", name: tag, udp: true, history: [{ time: "2026-07-17T08:00:00Z", delay: delays[i] }] };
  });
  return { proxies };
}

const fixtureLog = [
  "+0300 2026-07-17 12:00:01 INFO [system] Ninety runtime initialized",
  "+0300 2026-07-17 12:00:02 INFO [mixed-in] listening on 127.0.0.1:7890",
  "+0300 2026-07-17 12:00:03 INFO [🇩🇪 Frankfurt · Reality] outbound ready",
  "+0300 2026-07-17 12:00:04 DEBUG [dns] query github.com via dns-remote",
  "+0300 2026-07-17 12:00:05 INFO [proxy] connection to github.com:443 established",
  "+0300 2026-07-17 12:00:06 WARN [quality] temporary throughput drop; observing",
  "+0300 2026-07-17 12:00:07 INFO [quality] channel recovered without reconnect",
  "+0300 2026-07-17 12:00:08 INFO [route] windowsupdate.com matched direct rule",
  "+0300 2026-07-17 12:00:09 INFO [system] demo.invalid endpoints only",
].join("\n") + "\n";

async function captureView() {
  if (!realInvoke) return null;
  const links = await realInvoke("startup_deep_links").catch(() => []);
  for (const raw of links || []) {
    try {
      const url = new URL(raw);
      if (url.protocol === "ninety:" && url.hostname === "readme-capture") {
        return url.pathname.replace(/^\/+/, "") || "home";
      }
    } catch {}
  }
  return null;
}

function seedStorage() {
  for (let i = localStorage.length - 1; i >= 0; i--) {
    const key = localStorage.key(i);
    if (key?.startsWith("ninety.")) localStorage.removeItem(key);
  }
  const now = Date.now();
  const sub = {
    id: "sub_readme_demo",
    url: "https://subscription.demo.invalid/ninety",
    name: "190X4 DEMO NETWORK",
    lastUpdate: now - 4 * 60 * 1000,
    expire: Math.floor(now / 1000) + 153 * 86400,
    upload: 1432655872,
    download: 24668946432,
    total: 1099511627776,
    updateIntervalMode: "manual",
    updateIntervalHours: 6,
    serverUpdateIntervalHours: 6,
    profiles: nodes,
  };
  const standalone = {
    id: "profile_readme_demo",
    stableId: "profile-readme-demo",
    name: "🇸🇪 Stockholm · Backup",
    host: "se-sto.demo.invalid",
    port: 443,
    proto: "vless",
    type: "tcp",
    security: "reality",
    uuid: "00000000-0000-4000-8000-000000000099",
    sni: "www.microsoft.com",
    pbk: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    sid: "99",
  };
  const options = {
    region: "ru",
    general: { disableGeoLookup: true, autostart: false, startMinimized: false },
    quality: { enabled: true, aggressive: false, lowDataMode: true },
    experimental: { enableClashApi: true, clashApiPort: 9090 },
    route: { bypassLan: true, ipv6Mode: "disable", customRules: [] },
  };
  const values = {
    "ninety.lang": "ru",
    "ninety.theme": "kurogane",
    "ninety.mode": "systemProxy",
    "ninety.mode.migrated": "1",
    "ninety.onboarding.done": "1",
    "ninety.region.detected": "1",
    "ninety.active.kind": "sub",
    "ninety.subscriptions.active": sub.id,
    "ninety.subscriptions.v1": JSON.stringify([sub]),
    "ninety.profiles.v1": JSON.stringify([standalone]),
    "ninety.options.v1": JSON.stringify(options),
    "ninety.dpi.enabled": "true",
    "ninety.dpi.strategy": "ALT11",
    "ninety.dpi.gameFilter": "off",
    "ninety.dpi.ipset": "any",
    "ninety.dpi.monkey": "false",
    "ninety.traffic.sub:sub_readme_demo": JSON.stringify({ up: 186234112, down: 4862992384, total: 5049226496 }),
  };
  Object.entries(values).forEach(([key, value]) => localStorage.setItem(key, value));
  sessionStorage.clear();
}

function installInvokeFixture() {
  const fixture = async (command, args = {}) => {
    if (command === "startup_deep_links") return [];
    if (command === "state_backup_load") return null;
    if (command === "state_backup_save" || command === "state_backup_clear") return null;
    if (command === "is_portable" || command === "is_autostarted" || command === "should_autoconnect") return false;
    if (command === "is_elevated") return true;
    if (command === "is_always_admin" || command === "autostart_is_enabled") return false;
    if (command === "set_tray_menu") return null;
    if (command === "singbox_running") return false;
    if (command === "runtime_snapshot") return null;
    if (command === "health_snapshot") return { running: false, healthy: true };
    if (command === "xray_status") return { running: false };
    if (command === "sidecar_status") return [];
    if (command === "vpn_last_error") return null;
    if (command === "clash_get_proxies") return clashPayload();
    if (command === "clash_get_connections") return [];
    if (command === "clash_traffic_total") return { up: 186234112, down: 4862992384 };
    if (command === "clash_test_node") {
      const i = nodeTags.indexOf(args?.name);
      return { delay: delays[i >= 0 ? i : 0] };
    }
    if (command === "clash_test_group") return Object.fromEntries(nodeTags.map((tag, i) => [tag, delays[i]]));
    if (command === "clash_select_proxy") return null;
    if (command === "clash_traffic_start" || command === "clash_traffic_stop") return null;
    if (command === "fetch_public_ip") return { ip: "203.0.113.42", country: "Germany", country_code: "DE", asn: 64496, connection: { asn: 64496 }, success: true };
    if (command === "read_log" || command === "read_singbox_log" || command === "dpi_read_log") return fixtureLog;
    if (command === "singbox_log_path") return "C:\\Users\\demo\\AppData\\Local\\Ninety\\logs\\singbox.log";
    if (command === "dpi_log_path") return "C:\\Users\\demo\\AppData\\Local\\Ninety\\logs\\dpi.log";
    if (command === "dpi_strategies") return [
      { id: "alt11", name: "ALT11", desc: "Самый стойкий профиль для большинства сетей." },
      { id: "alt7", name: "ALT7", desc: "Сбалансированный профиль для HTTPS и Discord." },
      { id: "alt4", name: "ALT4", desc: "Мягкий профиль с минимальным вмешательством." },
      { id: "discord", name: "DISCORD", desc: "Оптимизирован для голосовых каналов Discord." },
    ];
    if (command === "dpi_running") return true;
    if (command === "dpi_domains_count") return 1248;
    if (command === "dpi_versions") return { app: "1.6.4", engine: "winws 2.2.3", strategies: "2026.07.17" };
    if (command === "dpi_check_update") return { available: false };
    if (command === "dpi_hosts_status") return { applied: true, entries: 2 };
    if (command === "dpi_ipset_count") return 8342;
    if (command === "dpi_read_list") return "discord.com\nyoutube.com\n";
    if (command === "warp_status") return { registered: false, enabled: false };
    if (command === "current_wifi") return null;
    if (command === "killswitch_active") return false;
    if (command.startsWith("plugin:updater|")) return null;
    if (command.startsWith("plugin:notification|")) return null;
    return realInvoke(command, args);
  };
  try {
    tauri.core.invoke = fixture;
  } catch {
    Object.defineProperty(tauri.core, "invoke", { value: fixture, configurable: true });
  }
}

async function prepareScreen(view) {
  const target = view === "nodes" ? "proxies" : view === "quality" ? "home" : view;
  await waitFor(() => document.querySelector(`.nav__item[data-view="${target}"]`));
  document.querySelector(`.nav__item[data-view="${target}"]`)?.click();
  await waitFor(() => {
    const screen = document.querySelector(`section.screen[data-view="${target}"]`);
    return screen && !screen.hidden;
  });

  if (view === "nodes") {
    await waitFor(() => document.querySelectorAll("#proxies-grid .prox").length >= 7);
  } else if (view === "profiles") {
    await waitFor(() => document.querySelectorAll("#profiles-list .prof-card").length >= 2);
  } else if (view === "logs") {
    await waitFor(() => document.querySelectorAll("#logs-view .log-line").length >= 5);
    const auto = document.querySelector("#logs-auto");
    if (auto) auto.checked = false;
  } else if (view === "dpi") {
    await waitFor(() => document.querySelector("#dpi-body .dpi-master"));
  }

  if (view === "home" || view === "quality") {
    const name = document.querySelector(".loc-card__name");
    const ping = document.querySelector("#loc-ping");
    if (name) name.textContent = "Frankfurt · Reality";
    if (ping) ping.textContent = "34 мс";
  }

  if (view === "quality") {
    const strip = document.querySelector("#stats-strip");
    if (strip) strip.hidden = false;
    const values = {
      "#stats-server": "Frankfurt · Reality",
      "#stats-ping": "34",
      "#stats-channel": "Отлично",
      "#stats-uptime": "18:42",
      "#stats-total": "↓ 4.53 ГБ · ↑ 178 МБ",
      "#stats-mode": "СИСТЕМНЫЙ",
    };
    Object.entries(values).forEach(([selector, value]) => {
      const el = document.querySelector(selector);
      if (el) el.textContent = value;
    });
    const channel = document.querySelector("#tele-channel");
    if (channel) {
      channel.dataset.q = "GOOD";
      channel.dataset.active = "true";
      const { openQualityScope } = await import("/lib/quality-scope.js");
      const samples = Array.from({ length: 46 }, (_, i) => ({
        bps: 1800000 + Math.sin(i / 3) * 420000 + (i % 9 === 0 ? -520000 : 0),
        q: i % 9 === 0 ? "SLOW" : "GOOD",
        rung: i === 13 ? "R1" : i === 31 ? "R2" : null,
      }));
      openQualityScope({ anchor: channel, getSamples: () => samples, goodBps: 1500000 });
      await waitFor(() => document.querySelector(".qscope"));
    }
  }

  const video = document.querySelector("#hero-mask");
  if (video) {
    try { video.pause(); video.currentTime = 0.65; } catch {}
  }
  await document.fonts.ready;
  await sleep(800);
}

const view = await captureView();
if (view) {
  seedStorage();
  installInvokeFixture();
}

await import("/main.js");

if (view) {
  try {
    await prepareScreen(view);
    await tauri?.window?.getCurrentWindow?.().setTitle?.(`Ninety README ${view} READY`);
  } catch (error) {
    console.error("README capture preparation failed", error);
    await tauri?.window?.getCurrentWindow?.().setTitle?.(`Ninety README ${view} ERROR`);
  }
}
