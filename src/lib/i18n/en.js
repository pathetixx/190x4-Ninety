// Ninety · catalog EN — hand-authored, plain English (same plain-language register as RU).
// Gold reference alongside RU; the other 13 catalogs fall back here when a key is missing.
export const en = {
  titlebar: { min: "Minimize", max: "Maximize", close: "Close" },

  nav: {
    home: "Home",
    profiles: "Profiles",
    proxies: "Nodes",
    dpi: "DPI Bypass",
    logs: "Logs",
    settings: "Settings",
  },

  traffic: { label: "Traffic · live", down: "Down", up: "Up" },

  home: {
    updated: "updated",
    daysLeft: "days left",
    openProfiles: "Open profiles",
    modeToggle: "Connection mode",
    addSub: "Add subscription",
  },

  hero: {
    notConnected: "Not connected",
    connecting: "Connecting…",
    secured: "Protected",
    apply: "Apply settings",
  },
  heroAria: {
    connect: "Connect",
    cancelConnect: "Cancel connecting",
    disconnect: "Disconnect",
  },

  stats: {
    server: "Server",
    ping: "Ping",
    channel: "Channel",
    session: "Session",
    mode: "Mode",
    modeSystem: "SYSTEM",
    pingTitle: "Refresh latency",
    channelTitle: "Channel quality",
  },

  mode: {
    popoverAria: "Connection mode",
    kicker: "CONNECTION MODE",
    proxy: "Proxy",
    systemProxy: "System proxy",
    tun: "VPN · TUN",
    warpExtra: "Extra security with WARP",
    hint: {
      proxy: "<b>For specific apps.</b> Protects only the apps where you set the proxy yourself — a browser, for example. The rest of your traffic goes direct. Handy when you just need to cover one thing.",
      systemProxy: "<b>For everything at once.</b> Turns on for every app that follows the system network settings — most browsers and apps. Nothing to configure by hand. Some games and Microsoft Store apps won't see it.",
      tun: "<b>Full protection.</b> All of your computer's traffic goes through the VPN — any program, game or app, no exceptions. You'll need to allow running as administrator once (or enable autostart with admin rights in Settings).",
    },
  },

  profiles: {
    title: "Profiles",
    sub: 'Subscriptions and standalone configs. The active profile is marked with a <span style="color:var(--accent-bright)">dot</span> — it is used when you connect.',
    refresh: "Refresh",
    add: "Add",
  },

  proxies: { title: "Nodes", metaNone: "No subscription selected" },

  dpi: {
    title: "DPI Bypass",
    sub: "Built-in unblocking for services that won't open directly. Runs alongside the VPN.",
  },

  logs: {
    title: "Logs",
    folder: "Folder",
    clear: "Clear",
    copy: "Copy",
    refresh: "Refresh",
    filterPlaceholder: "Filter",
    levelAll: "All",
    autoRefresh: "Auto-refresh · 2s",
    sourceAria: "Log source",
    levelAria: "Log level",
    searchAria: "Search logs",
  },

  region: {
    other: "Not set",
    ru: "Russia",
    cn: "China",
    ir: "Iran",
    tr: "Türkiye",
    by: "Belarus",
  },

  onb: {
    skip: "Skip",
    back: "Back",
    prefs: { language: "Language", region: "Region", theme: "Theme" },
    welcome: {
      title: "Welcome to Ninety",
      sub: "A native VPN client for Windows. In four steps we'll add your subscription and connect to the fastest node — that's it. Nothing to set up by hand.",
      start: "Get started",
    },
    import: {
      title: "Add a subscription",
      sub: "Paste a subscription URL or a <code>vless://</code> link. If it's already on your clipboard, we'll pick it up.",
      fromClipboard: "From clipboard",
      fromClipboardSub: "URL / vless:// / vmess://",
      manual: "Manually",
      manualSub: "URL + name + interval",
      supported: "Supported:",
    },
    connect: {
      title: "Connecting to the fastest node…",
      sub: "sing-box is starting and testing nodes over the clash API. This takes a couple of seconds.",
      cancel: "Cancel",
    },
    done: {
      title: "VPN connected",
      sub: "Your traffic now runs through the selected node. Any trouble — <code>Logs</code> in the sidebar. You can switch servers by clicking the location card.",
      open: "Open Ninety",
    },
  },

  settings: {
    language: "Interface language",
    languageHint: "Applies instantly — no restart needed.",
  },
};
