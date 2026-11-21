// Ninety · strict runtime privacy policy.
//
// The module is deliberately pure: it doesn't read localStorage, doesn't change saved
// settings and doesn't depend on DOM/Tauri. The UI prepares safe runtime arguments
// via prepareStrictPrivacyRuntime(), and the builder applies the same
// policy again as a fail-safe before building the sing-box config — so that it can't be
// bypassed around the UI.

import { DEFAULT_OPTIONS } from "/lib/options.js";

export const STRICT_PRIVACY_POLICY_ID = "strict-privacy-v1";

export class StrictPrivacyPolicyError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "StrictPrivacyPolicyError";
    this.code = code;
  }
}

function normalizedTag(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function createStrictPrivacyPolicy({ selectedNodeTag = null } = {}) {
  return Object.freeze({
    id: STRICT_PRIVACY_POLICY_ID,
    selectedNodeTag: normalizedTag(selectedNodeTag),
  });
}

export function isStrictPrivacyPolicy(policy) {
  return policy?.id === STRICT_PRIVACY_POLICY_ID;
}

export function applyStrictPrivacyOptions(options = DEFAULT_OPTIONS) {
  const source = options && typeof options === "object" ? options : DEFAULT_OPTIONS;
  const out = structuredClone(source);
  out.region = "other";
  out.general = {
    ...(out.general || {}),
    disableGeoLookup: true,
    allowDirectSubscriptionFallback: false,
  };
  out.warp = {
    ...(out.warp || {}),
    enabled: false,
    autoRescan: false,
  };
  out.dns = {
    ...(out.dns || {}),
    // The strict runtime doesn't inherit DoH with a hostname: its bootstrap would require
    // a separate direct DNS query to the protected resolver. One IP-hosted
    // DoH is used both inside the tunnel and only for the encrypted bootstrap of
    // the selected VPN server's address.
    remoteAddress: DEFAULT_OPTIONS.dns.remoteAddress,
    directAddress: DEFAULT_OPTIONS.dns.remoteAddress,
    enableFakeDns: false,
  };
  out.route = {
    ...(out.route || {}),
    bypassLan: false,
    resolveDestination: true,
    ipv6Mode: "disable",
    tunSplitDiscord: false,
    // Blocking and explicit proxy rules are safe. Direct exceptions in a strict
    // session are ignored but stay untouched in the saved settings.
    customRules: Array.isArray(out.route?.customRules)
      ? out.route.customRules.filter((rule) => rule?.action !== "direct")
      : [],
  };
  out.inbound = {
    ...(out.inbound || {}),
    strictRoute: true,
    allowConnectionFromLan: false,
  };
  out.quality = {
    ...(out.quality || {}),
    enabled: false,
  };
  return out;
}

export function resolveRuntimePrivacyPolicy({ mode, options, runtimePolicy } = {}) {
  if (!isStrictPrivacyPolicy(runtimePolicy)) {
    return {
      mode,
      options,
      strictPrivacy: false,
      selectedNodeTag: null,
    };
  }
  return {
    mode: "tun",
    options: applyStrictPrivacyOptions(options),
    strictPrivacy: true,
    selectedNodeTag: normalizedTag(runtimePolicy.selectedNodeTag),
  };
}

// The entry point main.js uses when the strict tunnel is on. The returned
// options are a separate copy; they go not only into the builder but also into the network
// actions around it (geo lookup, subscription update, mode selection).
export function prepareStrictPrivacyRuntime({ options, selectedNodeTag = null } = {}) {
  const runtimePolicy = createStrictPrivacyPolicy({ selectedNodeTag });
  const runtime = resolveRuntimePrivacyPolicy({
    mode: "tun",
    options,
    runtimePolicy,
  });
  return {
    mode: runtime.mode,
    options: runtime.options,
    runtimePolicy,
  };
}

// candidates: [{ tag, value }]. With 2+ nodes the policy requires a specific tag:
// a silent fallback to the first node or Auto would change the external IP without consent.
export function selectStrictPrivacyCandidate(candidates, selectedNodeTag) {
  const list = Array.isArray(candidates) ? candidates : [];
  if (!list.length) {
    throw new StrictPrivacyPolicyError(
      "STRICT_PRIVACY_NODE_UNAVAILABLE",
      "Для строгого режима нет доступной ноды",
    );
  }
  const tag = normalizedTag(selectedNodeTag);
  if (list.length === 1) {
    if (!tag || tag === "proxy") return list[0];
    if (tag === "auto" || tag === "lowest") {
      throw new StrictPrivacyPolicyError(
        "STRICT_PRIVACY_NODE_REQUIRED",
        "Для строгого режима нужно выбрать одну конкретную ноду",
      );
    }
    if (list[0]?.tag !== tag) {
      throw new StrictPrivacyPolicyError(
        "STRICT_PRIVACY_NODE_UNAVAILABLE",
        "Выбранная нода недоступна для строгого режима",
      );
    }
    return list[0];
  }

  if (!tag || tag === "auto" || tag === "lowest") {
    throw new StrictPrivacyPolicyError(
      "STRICT_PRIVACY_NODE_REQUIRED",
      "Для строгого режима нужно выбрать одну конкретную ноду",
    );
  }
  const selected = list.find((candidate) => candidate?.tag === tag);
  if (!selected) {
    throw new StrictPrivacyPolicyError(
      "STRICT_PRIVACY_NODE_UNAVAILABLE",
      "Выбранная нода недоступна для строгого режима",
    );
  }
  return selected;
}
