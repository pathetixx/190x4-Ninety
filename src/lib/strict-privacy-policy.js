// Ninety · строгая runtime-политика приватности.
//
// Модуль намеренно чистый: не читает localStorage, не меняет сохранённые
// настройки и не зависит от DOM/Tauri. UI готовит безопасные runtime-аргументы
// через prepareStrictPrivacyRuntime(), а builder повторно применяет ту же
// политику как fail-safe перед сборкой sing-box config — чтобы её нельзя было
// обойти мимо UI.

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
    // Строгий runtime не наследует DoH с hostname: его bootstrap потребовал бы
    // отдельного прямого DNS-запроса до защищённого резолвера. Один IP-hosted
    // DoH используется и внутри туннеля, и только для зашифрованного bootstrap
    // адреса выбранного VPN-сервера.
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
    // Блокирующие и явные proxy-правила безопасны. Direct-исключения в строгой
    // сессии игнорируются, но остаются нетронутыми в сохранённых настройках.
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

// Вход, которым пользуется main.js при включённом строгом туннеле. Возвращённые
// options — отдельная копия; они идут не только в builder, но и в сетевые
// действия вокруг него (geo lookup, обновление подписки, выбор режима).
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

// candidates: [{ tag, value }]. При 2+ нодах политика требует конкретный тег:
// молчаливый fallback на первую ноду или Auto поменял бы внешний IP без согласия.
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
