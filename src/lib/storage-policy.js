// Ninety · a single policy for localStorage keys.
//
// Settings and UI state stay in localStorage. Profiles/subscriptions are read
// from the Rust-owned profile store; the keys listed below are needed only for
// legacy migration/recovery fallback. The Rust-side backup is encrypted with DPAPI and must not
// be bloated by runtime telemetry and temporary markers.

const PREFIX = "ninety.";

export const STORAGE_KEYS = {
  options: "ninety.options.v1",
  profiles: "ninety.profiles.v1",
  profileActive: "ninety.profiles.active",
  subscriptions: "ninety.subscriptions.v1",
  subscriptionActive: "ninety.subscriptions.active",
  activeKind: "ninety.active.kind",
  proxySelection: "ninety.proxy.selection.v1",
  favourites: "ninety.favourites",
  delayHistory: "ninety.delayHistory.v1",
  mode: "ninety.mode",
  modeMigrated: "ninety.mode.migrated",
  strictTunnelPreviousMode: "ninety.privacy.strictTunnel.previousMode",
  theme: "ninety.theme",
  // "more" | "normal"; no key — the mode follows the system contrast setting.
  contrast: "ninety.contrast",
  // "on" — the calm main screen; no key — the live HUD.
  calmHud: "ninety.hud.calm",
  lang: "ninety.lang",
  onboardingStep: "ninety.onboarding.step",
  onboardingDone: "ninety.onboarding.done",
  regionDetected: "ninety.region.detected",
  updateResume: "ninety.update.resume",
  // "on" | "off": whether the VPN was connected on close — for "On launch: as it was".
  vpnLastState: "ninety.vpn.lastState",
  dpiResumeAfterUpdate: "ninety.dpi.resumeAfterUpdate",
  warpHistory: "ninety.warp.history",
  qualityProfile: "ninety.quality.profile",
  wifiTrusted: "ninety.wifi.trusted",
  // Device identifier for subscriptions with a device limit. Backed up
  // on purpose: after clearing WebView2 a new HWID would take another slot in the panel.
  deviceHwid: "ninety.hwid.v1",
  wifiPrevMode: "ninety.wifi.prevMode",
  // The keys live in their own modules (node-quarantine / incident-log /
  // runtime-identity) and are listed here so that the backup and cleanup policy
  // sees them on par with the rest: if they drifted apart, they would survive "clear
  // data" and go into the backup against the "we don't back up telemetry" rule.
  nodeQuarantine: "ninety.nodeQuarantine.v1",
  incidents: "ninety.incidents.v1",
  sourceRevisions: "ninety.source.revisions.v1",
  // "DPI bypass" screen settings: this is the user's choice, not telemetry, and they
  // go into the backup on par with the other settings.
  dpiEnabled: "ninety.dpi.enabled",
  dpiStrategy: "ninety.dpi.strategy",
  dpiGameFilter: "ninety.dpi.gameFilter",
  dpiIpset: "ninety.dpi.ipset",
  dpiMonkey: "ninety.dpi.monkey",
  dpiRecommended: "ninety.dpi.recommended",
  // The diagnostics tab and the skipped update version are also the user's
  // decisions, they survive a reinstall meaningfully.
  diagnoseTab: "ninety.diagnose.tab",
  updateSkip: "ninety.update.skip",
  // Pause after sending feedback. A local counter, the authority on the
  // limit is the server; it has no place in the backup (see BACKUP_EXACT_EXCLUDE).
  feedbackState: "ninety.feedback.v1",
};

// UI state of the "Servers" screen (sorting, display mode): keys like
// `ninety.proxies.<field>` are created by the screen itself, so the policy knows the prefix.
export const PROXIES_UI_PREFIX = "ninety.proxies.";

const BACKUP_EXACT_EXCLUDE = new Set([
  STORAGE_KEYS.updateResume,
  // State of the previous session: after a restore on another machine it belongs to someone else.
  STORAGE_KEYS.vpnLastState,
  STORAGE_KEYS.dpiResumeAfterUpdate,
  STORAGE_KEYS.warpHistory,
  STORAGE_KEYS.qualityProfile,
  STORAGE_KEYS.wifiTrusted,
  STORAGE_KEYS.wifiPrevMode,
  // Latency measurements are runtime telemetry, they have no place in the state backup.
  STORAGE_KEYS.delayHistory,
  // Of the same kind: node quarantine and the incident feed describe the previous session
  // (node fingerprints, core refusal reasons), and revision counters — already deleted
  // sources. After a restore they would come back to life and suppress live servers.
  STORAGE_KEYS.nodeQuarantine,
  STORAGE_KEYS.incidents,
  STORAGE_KEYS.sourceRevisions,
  // The feedback pause is a temporary marker of the same kind as update.resume:
  // after a restore it would belong to someone else's session.
  STORAGE_KEYS.feedbackState,
]);

// Traffic counters per source: they're maintained by traffic-meter, so the prefix lives
// here, and the module takes it from here.
export const TRAFFIC_PREFIX = "ninety.traffic.";

const BACKUP_PREFIX_EXCLUDE = [
  TRAFFIC_PREFIX,
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
  STORAGE_KEYS.proxySelection,
  // Tied to a subscription: cleared together with profiles, otherwise server tags
  // stay on disk after "clear data".
  STORAGE_KEYS.favourites,
  STORAGE_KEYS.delayHistory,
  // The quarantine is addressed by the node's semantic fingerprint, and it survives
  // a reimport: without cleanup the same servers would silently disappear from the config even
  // after "clear data" + re-adding the subscription.
  STORAGE_KEYS.nodeQuarantine,
]);

const PROFILE_STORAGE_PREFIXES = [
  TRAFFIC_PREFIX,
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
  // A legacy backup may contain more keys than the new policy. On restore
  // we take only what a new backup would save.
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
