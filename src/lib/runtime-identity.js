// Immutable identity реально запущенной конфигурации. Любая долгая операция
// захватывает token и обязана убедиться, что после await он всё ещё текущий.

const REVISION_KEY = "ninety.source.revisions.v1";

export class StaleRuntimeError extends Error {
  constructor(operation = "runtime operation") {
    super(`${operation}: устаревший runtime`);
    this.name = "StaleRuntimeError";
    this.code = "STALE_RUNTIME";
  }
}

export function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
}

// Не криптографическая подпись, а компактный детерминированный identity hash.
// Секреты никогда не попадают в tag/storage: в идентификатор уходит только hash.
export function hashRuntimeValue(value) {
  const s = typeof value === "string" ? value : stableStringify(value);
  let a = 0x811c9dc5, b = 0x9e3779b9;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x85ebca6b);
  }
  return `${(a >>> 0).toString(36)}${(b >>> 0).toString(36)}`;
}

export function sourceKey(source) {
  if (source?.kind === "sub") return `sub:${source.subscription?.id || source.id || ""}`;
  if (source?.kind === "single") return `profile:${source.profile?.id || source.id || ""}`;
  if (source?.kind === "warp") return "warp";
  return null;
}

const DISPLAY_ONLY_FIELDS = new Set(["name", "title", "remark", "clashTag"]);

function runtimeNodeShape(node) {
  if (!node || typeof node !== "object") return {};
  return Object.fromEntries(Object.entries(node)
    .filter(([key, value]) => !DISPLAY_ONLY_FIELDS.has(key) && key !== "id" && value !== undefined));
}

export function stableNodeId(node, namespace = "source") {
  const persisted = String(node?.stableId || node?.id || "").trim();
  if (persisted) return `${namespace}:${persisted}`;
  return `${namespace}:node:${hashRuntimeValue(runtimeNodeShape(node))}`;
}

export function nodeRuntimeFingerprint(node) {
  return hashRuntimeValue(runtimeNodeShape(node));
}

export function sourceFingerprint(source) {
  const key = sourceKey(source);
  if (!key) return null;
  const nodes = source.kind === "sub" ? (source.nodes || source.subscription?.profiles || [])
    : source.kind === "single" ? [source.profile]
      : [source.profile || { proto: "wireguard", host: "warp" }];
  // Порядок и display name не являются identity. Runtime-поля и credentials — да.
  const ids = nodes.map(node => ({
    id: stableNodeId(node, key),
    runtime: nodeRuntimeFingerprint(node),
  })).sort((a, b) => a.id.localeCompare(b.id));
  return hashRuntimeValue({ key, nodes: ids });
}

function loadRevisions(storage = globalThis.localStorage) {
  try {
    const v = JSON.parse(storage?.getItem(REVISION_KEY) || "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch { return {}; }
}

export function getSourceRevision(key, storage = globalThis.localStorage) {
  return Math.max(0, Number(loadRevisions(storage)[key]) || 0);
}

export function bumpSourceRevision(key, storage = globalThis.localStorage) {
  if (!key) return 0;
  const revisions = loadRevisions(storage);
  const next = Math.max(0, Number(revisions[key]) || 0) + 1;
  revisions[key] = next;
  storage?.setItem(REVISION_KEY, JSON.stringify(revisions));
  return next;
}

export function createRuntimeIdentityController({ getSource, getMode, getClashPort } = {}) {
  let connectionEpoch = 0;
  let processGeneration = 0;
  let current = null;

  function begin({ source = getSource?.(), mode = getMode?.(), configJson = "", clashPort } = {}) {
    const key = sourceKey(source);
    const token = Object.freeze({
      connectionEpoch: ++connectionEpoch,
      processGeneration: ++processGeneration,
      sourceKind: source?.kind || null,
      sourceId: key?.split(":").slice(1).join(":") || null,
      sourceKey: key,
      sourceRevision: getSourceRevision(key),
      sourceFingerprint: sourceFingerprint(source),
      configHash: hashRuntimeValue(configJson),
      mode: mode || "systemProxy",
      clashPort: Number(clashPort ?? getClashPort?.()) || 9090,
    });
    current = token;
    return token;
  }

  function invalidate() {
    connectionEpoch++;
    current = null;
  }

  function adopt(snapshot, { source = getSource?.() } = {}) {
    const key = sourceKey(source);
    const token = Object.freeze({
      connectionEpoch: ++connectionEpoch,
      processGeneration: Number(snapshot?.processGeneration) || ++processGeneration,
      sourceKind: source?.kind || null,
      sourceId: key?.split(":").slice(1).join(":") || null,
      sourceKey: key,
      sourceRevision: getSourceRevision(key),
      sourceFingerprint: snapshot?.sourceFingerprint || sourceFingerprint(source),
      configHash: snapshot?.configHash || null,
      mode: snapshot?.mode || getMode?.() || "systemProxy",
      clashPort: Number(snapshot?.clashPort) || 9090,
    });
    processGeneration = Math.max(processGeneration, token.processGeneration);
    current = token;
    return token;
  }

  function isCurrent(token) {
    return !!token && token === current
      && token.sourceRevision === getSourceRevision(token.sourceKey);
  }

  function assertCurrent(token, operation) {
    if (!isCurrent(token)) throw new StaleRuntimeError(operation);
    return token;
  }

  return { begin, adopt, invalidate, current: () => current, capture: () => current, isCurrent, assertCurrent };
}
