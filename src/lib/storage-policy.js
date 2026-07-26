// Ninety · единая политика localStorage-ключей.
//
// В localStorage остаются живые настройки и импортированные профили. Rust-side
// backup шифруется DPAPI, но не должен раздуваться runtime-телеметрией и
// временными маркерами.

const PREFIX = "ninety.";

export const STORAGE_KEYS = {
  options: "ninety.options.v1",
  profiles: "ninety.profiles.v1",
  profileActive: "ninety.profiles.active",
  subscriptions: "ninety.subscriptions.v1",
  subscriptionActive: "ninety.subscriptions.active",
  activeKind: "ninety.active.kind",
  mode: "ninety.mode",
  modeMigrated: "ninety.mode.migrated",
  strictTunnelPreviousMode: "ninety.privacy.strictTunnel.previousMode",
  theme: "ninety.theme",
  lang: "ninety.lang",
  onboardingStep: "ninety.onboarding.step",
  onboardingDone: "ninety.onboarding.done",
  regionDetected: "ninety.region.detected",
  updateResume: "ninety.update.resume",
  dpiResumeAfterUpdate: "ninety.dpi.resumeAfterUpdate",
  warpHistory: "ninety.warp.history",
  qualityProfile: "ninety.quality.profile",
  wifiTrusted: "ninety.wifi.trusted",
  wifiPrevMode: "ninety.wifi.prevMode",
};

const BACKUP_EXACT_EXCLUDE = new Set([
  STORAGE_KEYS.updateResume,
  STORAGE_KEYS.dpiResumeAfterUpdate,
  STORAGE_KEYS.warpHistory,
  STORAGE_KEYS.qualityProfile,
  STORAGE_KEYS.wifiTrusted,
  STORAGE_KEYS.wifiPrevMode,
]);

const BACKUP_PREFIX_EXCLUDE = [
  "ninety.traffic.",
];

const BACKUP_REGEX_EXCLUDE = [
  /^ninety\.sub\.[^.]+\.peakDays$/,
];

const PROFILE_STORAGE_KEYS = new Set([
  STORAGE_KEYS.profiles,
  STORAGE_KEYS.profileActive,
  STORAGE_KEYS.subscriptions,
  STORAGE_KEYS.subscriptionActive,
  STORAGE_KEYS.activeKind,
]);

const PROFILE_STORAGE_PREFIXES = [
  "ninety.traffic.",
];

const PROFILE_STORAGE_REGEXES = [
  /^ninety\.sub\.[^.]+\.peakDays$/,
];

export function isNinetyStorageKey(key) {
  return typeof key === "string" && key.startsWith(PREFIX);
}

function matchesAnyPrefix(key, prefixes) {
  return prefixes.some((prefix) => key.startsWith(prefix));
}

function matchesAnyRegex(key, regexes) {
  return regexes.some((re) => re.test(key));
}

export function shouldBackupStorageKey(key) {
  if (!isNinetyStorageKey(key)) return false;
  if (BACKUP_EXACT_EXCLUDE.has(key)) return false;
  if (matchesAnyPrefix(key, BACKUP_PREFIX_EXCLUDE)) return false;
  if (matchesAnyRegex(key, BACKUP_REGEX_EXCLUDE)) return false;
  return true;
}

export function shouldRestoreStorageKey(key) {
  // Легаси backup мог содержать больше ключей, чем новая политика. При restore
  // берём только то, что новый backup стал бы сохранять.
  return shouldBackupStorageKey(key);
}

export function clearProfileStorage({ includeOptions = false } = {}) {
  const removed = [];
  const keys = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!isNinetyStorageKey(key)) continue;
    if (
      PROFILE_STORAGE_KEYS.has(key) ||
      matchesAnyPrefix(key, PROFILE_STORAGE_PREFIXES) ||
      matchesAnyRegex(key, PROFILE_STORAGE_REGEXES) ||
      key === STORAGE_KEYS.warpHistory ||
      key === STORAGE_KEYS.qualityProfile ||
      key === STORAGE_KEYS.wifiTrusted ||
      key === STORAGE_KEYS.wifiPrevMode ||
      key === STORAGE_KEYS.updateResume ||
      key === STORAGE_KEYS.dpiResumeAfterUpdate ||
      (includeOptions && key === STORAGE_KEYS.options)
    ) {
      keys.push(key);
    }
  }
  for (const key of keys) {
    try {
      localStorage.removeItem(key);
      removed.push(key);
    } catch {}
  }
  return removed;
}
