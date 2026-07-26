const translations = {
  ru: {
    "nav.features": "Возможности",
    "nav.screens": "Интерфейс",
    "nav.docs": "Документация",
    "nav.safety": "Безопасность",
    "nav.github": "GitHub",
    "hero.eyebrow": "190X4 · SECURE TUNNEL",
    "hero.lead": "Desktop-клиент для Windows вокруг sing-box, WARP, правил маршрутизации и диагностики соединения.",
    "hero.note": "Не обещает анонимность. Даёт аккуратное управление подключением, режимами Windows и видимую диагностику.",
    "hero.download": "Скачать",
    "hero.docs": "Документация",
    "hero.stat.platform.label": "Платформа",
    "hero.stat.platform.value": "Windows 10 / 11 x64",
    "hero.stat.stack.label": "Стек",
    "hero.stat.stack.value": "Tauri 2 · Rust",
    "hero.stat.core.label": "Ядро",
    "hero.stat.core.value": "sing-box ecosystem",
    "intro.kicker": "Windows networking client",
    "intro.title": "Один интерфейс для профилей, режимов и диагностики",
    "intro.copy": "Ninety собирает подписки, одиночные профили, WARP, TUN, маршрутизацию, логи и автообновления в один desktop-клиент. Фокус проекта — предсказуемое состояние подключения, честные ограничения и аккуратная работа с системными настройками Windows.",
    "features.kicker": "Возможности",
    "features.title": "Сетевой клиент без лишнего шума",
    "feature.modes.title": "Режимы Windows",
    "feature.modes.copy": "Локальный proxy, системный proxy, VPN · TUN и WARP-only. Elevated-режим используется только там, где он действительно нужен.",
    "feature.sources.title": "Источники",
    "feature.sources.copy": "Подписки, standalone-ссылки и TrustTunnel endpoint-файлы. Импорт из буфера и deep links держатся в одном пользовательском потоке.",
    "feature.routing.title": "Маршрутизация",
    "feature.routing.copy": "LAN bypass, региональные правила, пользовательские правила по доменам, IP и процессам, плюс отдельный монитор активных соединений.",
    "feature.quality.title": "Качество канала",
    "feature.quality.copy": "Проверки задержки, throughput-наблюдение, перепроверка узлов, подсказки по восстановлению и понятные логи вместо пустого статуса.",
    "feature.sidecars.title": "Sidecar engines",
    "feature.sidecars.copy": "sing-box остаётся центральным роутером, а XHTTP, NaiveProxy и TrustTunnel подключаются через локальные мосты, когда профиль этого требует.",
    "feature.desktop.title": "Desktop UX",
    "feature.desktop.copy": "Трей, восстановление после обновления, темы, onboarding, локализации и осторожные дефолты для логов и runtime-конфигов.",
    "screens.kicker": "Интерфейс",
    "screens.title": "Реальное состояние подключения видно сразу",
    "screens.home": "Главная",
    "screens.nodes": "Ноды",
    "screens.profiles": "Профили",
    "screens.settings": "Настройки",
    "screens.quality": "Качество",
    "docs.kicker": "Документация",
    "docs.title": "Быстрый вход без раскрытия приватных данных",
    "docs.copy": "Документация объясняет режимы, privacy-модель, routing и troubleshooting без публикации приватных URL, UUID, ключей, WARP state или полных конфигов.",
    "docs.user": "User docs",
    "docs.arch": "Architecture",
    "docs.release": "Release ritual",
    "release.label": "CURRENT RELEASE",
    "release.copy": "Релизы публикуются через annotated tags, draft release и CI-артефакты. OTA changelog берётся из latest.json, а не из уже опубликованного текста релиза.",
    "release.link": "Открыть релиз",
    "release.exe": "Installer .exe",
    "release.msi": "MSI",
    "release.meta.loading": "Проверяю последний релиз...",
    "release.meta.fallback": "Последний релиз откроется через GitHub.",
    "release.meta.published": "Опубликован {date}",
    "release.meta.assets": "EXE/MSI найдены автоматически",
    "release.meta.exeOnly": "EXE найден автоматически",
    "safety.kicker": "Safety notes",
    "safety.title": "Сильные сетевые инструменты требуют честных ограничений",
    "safety.privacy.title": "Не гарантия анонимности",
    "safety.privacy.copy": "Приватность зависит от сервера, провайдера, профиля и окружения Windows. Ninety помогает управлять подключением, но не меняет эту базовую модель доверия.",
    "safety.secrets.title": "Секреты не публикуются",
    "safety.secrets.copy": "В публичные issues нельзя вставлять subscription URLs, UUID, токены, private keys, WARP data и полные экспортированные конфиги.",
    "safety.system.title": "Системные режимы заметны",
    "safety.system.copy": "TUN, kill switch и DPI-совместимость могут менять сетевое состояние Windows. Включайте их осознанно и проверяйте настройки перед репортом.",
    "footer.copy": "Open-source Windows desktop networking client.",
    "footer.github": "GitHub",
    "footer.download": "Download",
    "footer.security": "Security",
    "footer.privacy": "Privacy",
    "footer.signing": "Политика подписи",
    "footer.feedback": "Feedback",
  },
  en: {
    "nav.features": "Features",
    "nav.screens": "Interface",
    "nav.docs": "Docs",
    "nav.safety": "Safety",
    "nav.github": "GitHub",
    "hero.eyebrow": "190X4 · SECURE TUNNEL",
    "hero.lead": "A Windows desktop networking client built around sing-box, WARP, routing rules and connection diagnostics.",
    "hero.note": "Not an anonymity guarantee. Ninety gives you careful connection control, Windows mode handling and visible diagnostics.",
    "hero.download": "Download",
    "hero.docs": "Documentation",
    "hero.stat.platform.label": "Platform",
    "hero.stat.platform.value": "Windows 10 / 11 x64",
    "hero.stat.stack.label": "Stack",
    "hero.stat.stack.value": "Tauri 2 · Rust",
    "hero.stat.core.label": "Core",
    "hero.stat.core.value": "sing-box ecosystem",
    "intro.kicker": "Windows networking client",
    "intro.title": "One interface for profiles, modes and diagnostics",
    "intro.copy": "Ninety brings subscriptions, standalone profiles, WARP, TUN, routing, logs and auto-updates into one desktop client. The project focuses on predictable connection state, honest limitations and careful Windows network handling.",
    "features.kicker": "Features",
    "features.title": "A networking client without the noise",
    "feature.modes.title": "Windows modes",
    "feature.modes.copy": "Local proxy, system proxy, VPN · TUN and WARP-only. Elevated mode is used only when the selected mode actually needs it.",
    "feature.sources.title": "Sources",
    "feature.sources.copy": "Subscriptions, standalone links and TrustTunnel endpoint files. Clipboard import and deep links stay in one user flow.",
    "feature.routing.title": "Routing",
    "feature.routing.copy": "LAN bypass, regional rules, custom domain/IP/process rules and a separate live connections monitor.",
    "feature.quality.title": "Channel quality",
    "feature.quality.copy": "Delay checks, throughput watching, node re-tests, recovery hints and useful logs instead of a vague connected label.",
    "feature.sidecars.title": "Sidecar engines",
    "feature.sidecars.copy": "sing-box remains the central router, while XHTTP, NaiveProxy and TrustTunnel are attached through local bridges when a profile requires them.",
    "feature.desktop.title": "Desktop UX",
    "feature.desktop.copy": "Tray control, post-update session restore, themes, onboarding, localizations and cautious defaults for logs and runtime configs.",
    "screens.kicker": "Interface",
    "screens.title": "The real connection state is visible at a glance",
    "screens.home": "Home",
    "screens.nodes": "Nodes",
    "screens.profiles": "Profiles",
    "screens.settings": "Settings",
    "screens.quality": "Quality",
    "docs.kicker": "Documentation",
    "docs.title": "A quick start without exposing private data",
    "docs.copy": "The docs explain modes, privacy, routing and troubleshooting without asking users to publish private URLs, UUIDs, keys, WARP state or full configs.",
    "docs.user": "User docs",
    "docs.arch": "Architecture",
    "docs.release": "Release ritual",
    "release.label": "CURRENT RELEASE",
    "release.copy": "Releases are published through annotated tags, draft releases and CI assets. The OTA changelog comes from latest.json, not from an already published release body.",
    "release.link": "Open release",
    "release.exe": "Installer .exe",
    "release.msi": "MSI",
    "release.meta.loading": "Checking latest release...",
    "release.meta.fallback": "Latest release opens through GitHub.",
    "release.meta.published": "Published {date}",
    "release.meta.assets": "EXE/MSI found automatically",
    "release.meta.exeOnly": "EXE found automatically",
    "safety.kicker": "Safety notes",
    "safety.title": "Powerful networking tools need honest limits",
    "safety.privacy.title": "Not anonymity",
    "safety.privacy.copy": "Privacy depends on the server, provider, profile and Windows environment. Ninety helps manage the connection, but it does not change that trust model.",
    "safety.secrets.title": "Do not publish secrets",
    "safety.secrets.copy": "Public issues must not include subscription URLs, UUIDs, tokens, private keys, WARP data or full exported configs.",
    "safety.system.title": "System modes are visible",
    "safety.system.copy": "TUN, kill switch and DPI compatibility can change Windows networking state. Enable them deliberately and check settings before reporting bugs.",
    "footer.copy": "Open-source Windows desktop networking client.",
    "footer.github": "GitHub",
    "footer.download": "Download",
    "footer.security": "Security",
    "footer.privacy": "Privacy",
    "footer.signing": "Code signing policy",
    "footer.feedback": "Feedback",
  },
};

const releaseFallback = {
  tagName: "v0.2.40",
  htmlUrl: "https://github.com/pathetixx/190x4-Ninety/releases/latest",
  exeUrl: "https://github.com/pathetixx/190x4-Ninety/releases/latest",
  msiUrl: "https://github.com/pathetixx/190x4-Ninety/releases/latest",
  publishedAt: "",
  hasExe: false,
  hasMsi: false,
};

const screens = {
  home: {
    src: "assets/screen-home.webp",
    alt: {
      ru: "Главный экран Ninety",
      en: "Ninety home screen",
    },
  },
  nodes: {
    src: "assets/screen-nodes.webp",
    alt: {
      ru: "Экран нод Ninety",
      en: "Ninety nodes screen",
    },
  },
  profiles: {
    src: "assets/screen-profiles.webp",
    alt: {
      ru: "Экран профилей Ninety",
      en: "Ninety profiles screen",
    },
  },
  settings: {
    src: "assets/screen-settings.webp",
    alt: {
      ru: "Настройки Ninety",
      en: "Ninety settings screen",
    },
  },
  quality: {
    src: "assets/screen-quality.webp",
    alt: {
      ru: "Экран качества соединения Ninety",
      en: "Ninety connection quality screen",
    },
  },
};

function getStoredLanguage() {
  try {
    return localStorage.getItem("ninety-site-language") || "ru";
  } catch {
    return "ru";
  }
}

let currentLanguage = getStoredLanguage();
let currentScreen = "home";
let latestRelease = releaseFallback;
let latestReleaseLoaded = false;

const topbar = document.querySelector("[data-topbar]");
const screenImage = document.querySelector("[data-screen-image]");
const releaseVersionNodes = document.querySelectorAll("[data-release-version]");
const releaseMetaNodes = document.querySelectorAll("[data-release-meta]");
const releaseLinkNodes = document.querySelectorAll("[data-release-link]");
const downloadLinkNodes = document.querySelectorAll("[data-download-link]");
const msiLinkNodes = document.querySelectorAll("[data-msi-link]");

function t(key) {
  return translations[currentLanguage][key] || translations.ru[key] || key;
}

function formatTemplate(template, values) {
  return Object.entries(values).reduce((result, [key, value]) => {
    return result.replace(`{${key}}`, value);
  }, template);
}

function storeLanguage(language) {
  try {
    localStorage.setItem("ninety-site-language", language);
  } catch {
    // В приватном или ограниченном режиме браузер может запретить localStorage.
  }
}

function formatReleaseDate(value) {
  if (!value) {
    return "";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }

  return new Intl.DateTimeFormat(currentLanguage === "ru" ? "ru-RU" : "en-US", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(date);
}

function pickReleaseAsset(assets, matcher) {
  return assets.find((asset) => matcher.test(asset.name || ""));
}

function normalizeRelease(data) {
  const assets = Array.isArray(data.assets) ? data.assets : [];
  const exeAsset =
    pickReleaseAsset(assets, /^Ninety_.*_x64-setup\.exe$/i) ||
    pickReleaseAsset(assets, /\.exe$/i);
  const msiAsset = pickReleaseAsset(assets, /\.msi$/i);
  const htmlUrl = data.html_url || releaseFallback.htmlUrl;

  return {
    tagName: data.tag_name || releaseFallback.tagName,
    htmlUrl,
    exeUrl: exeAsset?.browser_download_url || htmlUrl,
    msiUrl: msiAsset?.browser_download_url || htmlUrl,
    publishedAt: data.published_at || "",
    hasExe: Boolean(exeAsset?.browser_download_url),
    hasMsi: Boolean(msiAsset?.browser_download_url),
  };
}

function releaseMetaText() {
  if (!latestReleaseLoaded) {
    return t("release.meta.fallback");
  }

  const parts = [];
  const date = formatReleaseDate(latestRelease.publishedAt);
  if (date) {
    parts.push(formatTemplate(t("release.meta.published"), { date }));
  }
  if (latestRelease.hasExe && latestRelease.hasMsi) {
    parts.push(t("release.meta.assets"));
  } else if (latestRelease.hasExe) {
    parts.push(t("release.meta.exeOnly"));
  }

  return parts.join(" · ") || t("release.meta.fallback");
}

function renderRelease() {
  releaseVersionNodes.forEach((node) => {
    node.textContent = latestRelease.tagName;
  });
  releaseMetaNodes.forEach((node) => {
    node.textContent = releaseMetaText();
  });
  releaseLinkNodes.forEach((node) => {
    node.href = latestRelease.htmlUrl;
  });
  downloadLinkNodes.forEach((node) => {
    node.href = latestRelease.exeUrl;
  });
  msiLinkNodes.forEach((node) => {
    node.href = latestRelease.msiUrl;
  });
}

async function loadLatestRelease() {
  releaseMetaNodes.forEach((node) => {
    node.textContent = t("release.meta.loading");
  });

  try {
    latestRelease = await loadReleaseFromSiteMetadata();
    latestReleaseLoaded = true;
  } catch {
    try {
      latestRelease = await loadReleaseFromGitHubApi();
      latestReleaseLoaded = true;
    } catch {
      latestRelease = releaseFallback;
      latestReleaseLoaded = false;
    }
  }

  renderRelease();
}

async function loadReleaseFromSiteMetadata() {
  const response = await fetch("release.json", { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Local release metadata request failed: ${response.status}`);
  }

  return normalizeRelease(await response.json());
}

async function loadReleaseFromGitHubApi() {
  const response = await fetch("https://api.github.com/repos/pathetixx/190x4-Ninety/releases/latest", {
    headers: {
      Accept: "application/vnd.github+json",
    },
  });
  if (!response.ok) {
    throw new Error(`GitHub latest release request failed: ${response.status}`);
  }

  return normalizeRelease(await response.json());
}

function setLanguage(language) {
  currentLanguage = translations[language] ? language : "ru";
  document.documentElement.lang = currentLanguage;
  storeLanguage(currentLanguage);

  document.querySelectorAll("[data-i18n]").forEach((node) => {
    const value = t(node.dataset.i18n);
    if (value) {
      node.textContent = value;
    }
  });

  document.querySelectorAll("[data-lang]").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.lang === currentLanguage);
  });

  updateScreen(currentScreen);
  renderRelease();
}

function updateScreen(name) {
  currentScreen = screens[name] ? name : "home";
  const selected = screens[currentScreen];
  screenImage.src = selected.src;
  screenImage.alt = selected.alt[currentLanguage];

  document.querySelectorAll("[data-screen]").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.screen === currentScreen);
  });
}

document.querySelectorAll("[data-lang]").forEach((button) => {
  button.addEventListener("click", () => setLanguage(button.dataset.lang));
});

document.querySelectorAll("[data-screen]").forEach((button) => {
  button.addEventListener("click", () => updateScreen(button.dataset.screen));
});

window.addEventListener("scroll", () => {
  topbar.classList.toggle("is-scrolled", window.scrollY > 12);
});

setLanguage(currentLanguage);
updateScreen(currentScreen);
loadLatestRelease();
