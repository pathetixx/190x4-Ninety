from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def write(path: str, content: str) -> None:
    target = ROOT / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding="utf-8", newline="\n")


def replace_once(path: str, old: str, new: str) -> None:
    content = read(path)
    count = content.count(old)
    if count != 1:
        raise RuntimeError(
            f"{path}: expected exactly one replacement, found {count}: {old[:180]!r}"
        )
    write(path, content.replace(old, new, 1))


def replace_count(path: str, old: str, new: str, expected: int) -> None:
    content = read(path)
    count = content.count(old)
    if count != expected:
        raise RuntimeError(
            f"{path}: expected {expected} replacements, found {count}: {old[:180]!r}"
        )
    write(path, content.replace(old, new))


def regex_replace_once(path: str, pattern: str, replacement: str) -> None:
    content = read(path)
    updated, count = re.subn(pattern, replacement, content, count=1, flags=re.S | re.M)
    if count != 1:
        raise RuntimeError(f"{path}: regex replacement count={count}: {pattern[:180]!r}")
    write(path, updated)


# ---------------------------------------------------------------------------
# 1. A remembered node is preference state, not runtime readiness.
#    In ordinary mode, a provider-removed/rekeyed node must fall back to the
#    source's explicit automatic policy instead of killing a healthy runtime.
#    Strict Privacy does not use this path and keeps its mandatory pin policy.
# ---------------------------------------------------------------------------
proxy_path = "src/lib/proxy-selection.js"
proxy_content = read(proxy_path)
marker = "export async function restoreRememberedProxySelection({"
start = proxy_content.find(marker)
if start < 0:
    raise RuntimeError("restoreRememberedProxySelection marker not found")
write(
    proxy_path,
    proxy_content[:start]
    + r'''export async function restoreRememberedProxySelection({
  source,
  topology,
  apply,
  isCurrent = () => true,
  attempts = 3,
  retryDelayMs = 140,
  wait = sleep,
}) {
  let tag = getRememberedProxySelection(source);
  if (!tag) return { status: "none", tag: null };

  const selector = topology?.proxies?.proxy;
  const selectableTags = Array.isArray(selector?.all) ? selector.all : [];
  const selectorType = String(selector?.type || "").toLowerCase();
  const isSelector = selectorType === "selector" || selectableTags.length > 0;

  // A source which now has one physical route cannot restore an old selector
  // child. Normalise stale auto/manual state to the only runtime tag.
  if (!isSelector) {
    if (tag === "proxy") return { status: "current", tag };
    if (!isCurrent()) return { status: "stale", tag };
    const previousTag = tag;
    rememberProxySelection(source, "proxy");
    return {
      status: "reset",
      tag: "proxy",
      previousTag,
      reason: "single_route_normalized",
    };
  }

  let previousTag = null;
  let resetReason = null;

  // Legacy singleton runtimes stored "proxy" as the effective outbound. In a
  // multi-node runtime it is the selector group name, not a selectable child.
  if (tag === "proxy" && selectableTags.includes("auto")) {
    previousTag = tag;
    resetReason = "legacy_singleton_selection";
    tag = "auto";
  }

  // Subscription refresh/provider rotation may remove or re-key a previously
  // selected node. This must not make the whole subscription unusable. The
  // only permitted automatic recovery is the explicit app policy "auto"; no
  // arbitrary node is silently substituted.
  if (!selectableTags.includes(tag)) {
    if (!selectableTags.includes("auto")) {
      return { status: "unavailable", tag };
    }
    previousTag = tag;
    resetReason = "remembered_selection_unavailable";
    tag = "auto";
  }

  if (selector?.now === tag) {
    if (previousTag == null) return { status: "current", tag };
    if (!isCurrent()) return { status: "stale", tag };
    rememberProxySelection(source, tag);
    return {
      status: "reset",
      tag,
      previousTag,
      reason: resetReason,
    };
  }

  let lastError = null;
  const maxAttempts = Math.max(1, Number(attempts) || 1);
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (!isCurrent()) return { status: "stale", tag };
    try {
      const result = await apply(tag);
      if (result?.stale || !isCurrent()) return { status: "stale", tag };
      if (previousTag != null) {
        // Persist only after Clash confirms the fallback. A failed or stale
        // apply keeps the previous preference transactionally intact.
        rememberProxySelection(source, tag);
        return {
          status: "reset",
          tag,
          previousTag,
          reason: resetReason,
        };
      }
      return { status: "restored", tag };
    } catch (error) {
      lastError = error;
      if (attempt + 1 < maxAttempts) await wait(retryDelayMs * (attempt + 1));
    }
  }
  throw lastError || new Error(`Не удалось восстановить выбранный сервер ${tag}`);
}
''',
)

write(
    "tests/proxy-selection.test.mjs",
    r'''import test from "node:test";
import assert from "node:assert/strict";
import {
  getRememberedProxySelection,
  rememberProxySelection,
  restoreRememberedProxySelection,
  selectionSourceKey,
} from "../src/lib/proxy-selection.js";

function installStorage() {
  const values = new Map();
  globalThis.localStorage = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
  };
}

test("выбранный сервер хранится отдельно для каждой подписки", () => {
  installStorage();
  const first = { kind: "sub", subscription: { id: "first" } };
  const second = { kind: "sub", subscription: { id: "second" } };
  rememberProxySelection(first, "node-stable-a");
  rememberProxySelection(second, "auto");
  assert.equal(getRememberedProxySelection(first), "node-stable-a");
  assert.equal(getRememberedProxySelection(second), "auto");
  assert.equal(selectionSourceKey(first), "sub:first");
});

test("повреждённое хранилище безопасно игнорируется", () => {
  installStorage();
  localStorage.setItem("ninety.proxy.selection.v1", "{");
  assert.equal(getRememberedProxySelection({ kind: "sub", subscription: { id: "first" } }), null);
});

test("сохранённая нода восстанавливается после временных ошибок API, не оставаясь на Авто", async () => {
  installStorage();
  const source = { kind: "sub", subscription: { id: "stable" } };
  rememberProxySelection(source, "node-last");
  let calls = 0;
  const result = await restoreRememberedProxySelection({
    source,
    topology: { proxies: { proxy: { now: "auto", all: ["auto", "node-last"] } } },
    apply: async (tag) => {
      calls++;
      assert.equal(tag, "node-last");
      if (calls < 3) throw new Error("Clash API ещё не готов");
      return { stale: false };
    },
    wait: async () => {},
  });
  assert.deepEqual(result, { status: "restored", tag: "node-last" });
  assert.equal(calls, 3);
});

test("legacy singleton proxy мигрирует в auto у многонодовой подписки", async () => {
  installStorage();
  const source = { kind: "sub", subscription: { id: "expanded" } };
  rememberProxySelection(source, "proxy");
  let calls = 0;
  const result = await restoreRememberedProxySelection({
    source,
    topology: {
      proxies: {
        proxy: { type: "Selector", now: "auto", all: ["auto", "lowest", "node-a"] },
      },
    },
    apply: async () => { calls++; },
  });
  assert.deepEqual(result, {
    status: "reset",
    tag: "auto",
    previousTag: "proxy",
    reason: "legacy_singleton_selection",
  });
  assert.equal(getRememberedProxySelection(source), "auto");
  assert.equal(calls, 0);
});

test("устаревшая ручная нода сбрасывается на auto и не блокирует смену подписки", async () => {
  installStorage();
  const source = { kind: "sub", subscription: { id: "rotated" } };
  rememberProxySelection(source, "node-provider-removed");
  let calls = 0;
  const result = await restoreRememberedProxySelection({
    source,
    topology: {
      proxies: {
        proxy: { type: "Selector", now: "auto", all: ["auto", "lowest", "node-new"] },
      },
    },
    apply: async () => { calls++; },
  });
  assert.deepEqual(result, {
    status: "reset",
    tag: "auto",
    previousTag: "node-provider-removed",
    reason: "remembered_selection_unavailable",
  });
  assert.equal(getRememberedProxySelection(source), "auto");
  assert.equal(calls, 0);
});

test("сброс на auto сначала подтверждается Clash и только затем сохраняется", async () => {
  installStorage();
  const source = { kind: "sub", subscription: { id: "rotated-apply" } };
  rememberProxySelection(source, "node-provider-removed");
  let calls = 0;
  const result = await restoreRememberedProxySelection({
    source,
    topology: {
      proxies: {
        proxy: { type: "Selector", now: "lowest", all: ["auto", "lowest", "node-new"] },
      },
    },
    apply: async (tag) => {
      calls++;
      assert.equal(getRememberedProxySelection(source), "node-provider-removed");
      assert.equal(tag, "auto");
      return { stale: false };
    },
  });
  assert.equal(result.status, "reset");
  assert.equal(result.tag, "auto");
  assert.equal(getRememberedProxySelection(source), "auto");
  assert.equal(calls, 1);
});

test("ошибка применения fallback не уничтожает старое сохранённое предпочтение", async () => {
  installStorage();
  const source = { kind: "sub", subscription: { id: "rotated-fail" } };
  rememberProxySelection(source, "node-provider-removed");
  await assert.rejects(
    restoreRememberedProxySelection({
      source,
      topology: {
        proxies: {
          proxy: { type: "Selector", now: "lowest", all: ["auto", "lowest", "node-new"] },
        },
      },
      attempts: 1,
      apply: async () => { throw new Error("Clash unavailable"); },
    }),
    /Clash unavailable/,
  );
  assert.equal(getRememberedProxySelection(source), "node-provider-removed");
});

test("многонодовый selector без auto не подменяет удалённую ноду произвольным маршрутом", async () => {
  installStorage();
  const source = { kind: "sub", subscription: { id: "malformed" } };
  rememberProxySelection(source, "node-removed");
  let calls = 0;
  const result = await restoreRememberedProxySelection({
    source,
    topology: {
      proxies: {
        proxy: { type: "Selector", now: "node-new", all: ["lowest", "node-new"] },
      },
    },
    apply: async () => { calls++; },
  });
  assert.deepEqual(result, { status: "unavailable", tag: "node-removed" });
  assert.equal(getRememberedProxySelection(source), "node-removed");
  assert.equal(calls, 0);
});

test("любой старый selector tag нормализуется в proxy когда источник стал одиночным", async () => {
  installStorage();
  const source = { kind: "sub", subscription: { id: "shrunk" } };
  rememberProxySelection(source, "node-old");
  let calls = 0;
  const result = await restoreRememberedProxySelection({
    source,
    topology: { proxies: { proxy: { type: "VLESS" } } },
    apply: async () => { calls++; },
  });
  assert.deepEqual(result, {
    status: "reset",
    tag: "proxy",
    previousTag: "node-old",
    reason: "single_route_normalized",
  });
  assert.equal(getRememberedProxySelection(source), "proxy");
  assert.equal(calls, 0);
});
''',
)


# ---------------------------------------------------------------------------
# 2. Make the System Proxy IPC contract explicit. Tauri rejected calls which
#    omitted optional top-level keys before Rust could see enable=false. Split
#    enable/disable commands so a disable operation has zero irrelevant args.
# ---------------------------------------------------------------------------
write(
    "src/lib/system-proxy-runtime.js",
    r'''function requireInvoke(invoke) {
  if (typeof invoke !== "function") throw new TypeError("Tauri invoke is required");
}

export function enableSystemProxy(invoke, {
  hostPort,
  bypassLan = true,
  expectedGeneration,
} = {}) {
  requireInvoke(invoke);
  const endpoint = typeof hostPort === "string" ? hostPort.trim() : "";
  const generation = Number(expectedGeneration);
  if (!endpoint) throw new TypeError("system proxy requires a runtime endpoint");
  if (!Number.isSafeInteger(generation) || generation <= 0) {
    throw new TypeError("system proxy requires a positive runtime generation");
  }
  return invoke("enable_system_proxy", {
    hostPort: endpoint,
    bypassLan: bypassLan !== false,
    expectedGeneration: generation,
  });
}

export function disableSystemProxy(invoke) {
  requireInvoke(invoke);
  return invoke("disable_system_proxy");
}
''',
)

write(
    "tests/system-proxy-runtime.test.mjs",
    r'''import test from "node:test";
import assert from "node:assert/strict";
import {
  disableSystemProxy,
  enableSystemProxy,
} from "../src/lib/system-proxy-runtime.js";

test("enable system proxy always sends the complete generation-bound contract", async () => {
  const calls = [];
  const result = await enableSystemProxy(async (...args) => {
    calls.push(args);
    return "ok";
  }, {
    hostPort: " 127.0.0.1:7890 ",
    bypassLan: false,
    expectedGeneration: 12,
  });
  assert.equal(result, "ok");
  assert.deepEqual(calls, [["enable_system_proxy", {
    hostPort: "127.0.0.1:7890",
    bypassLan: false,
    expectedGeneration: 12,
  }]]);
});

test("disable system proxy has a zero-argument IPC contract", async () => {
  const calls = [];
  await disableSystemProxy(async (...args) => { calls.push(args); });
  assert.deepEqual(calls, [["disable_system_proxy"]]);
});

test("invalid enable request is rejected before IPC", () => {
  let calls = 0;
  const invoke = () => { calls++; };
  assert.throws(() => enableSystemProxy(invoke, {
    hostPort: "",
    expectedGeneration: 1,
  }), /runtime endpoint/);
  assert.throws(() => enableSystemProxy(invoke, {
    hostPort: "127.0.0.1:7890",
    expectedGeneration: 0,
  }), /positive runtime generation/);
  assert.equal(calls, 0);
});
''',
)

replace_once(
    "src/main.js",
    '''import { getRememberedProxySelection, restoreRememberedProxySelection } from "/lib/proxy-selection.js";
''',
    '''import { getRememberedProxySelection, restoreRememberedProxySelection } from "/lib/proxy-selection.js";
import { disableSystemProxy, enableSystemProxy } from "/lib/system-proxy-runtime.js";
''',
)

replace_count(
    "src/main.js",
    '''try { await invoke("set_system_proxy", { enable: false }); } catch {}''',
    '''try { await disableSystemProxy(invoke); } catch {}''',
    3,
)

replace_once(
    "src/main.js",
    '''        await invoke("set_system_proxy", {
          enable: true,
          hostPort: probeHostPort,
          bypassLan: options.route?.bypassLan !== false,
          expectedGeneration: runtimeSnapshot.processGeneration,
        });
''',
    '''        await enableSystemProxy(invoke, {
          hostPort: probeHostPort,
          bypassLan: options.route?.bypassLan !== false,
          expectedGeneration: runtimeSnapshot.processGeneration,
        });
''',
)

replace_once(
    "src/main.js",
    '''        // Никогда не маскируем потерю ручного выбора тихим переходом на Auto.
        // Если сервер действительно исчез из подписки, безопаснее не поднимать
        // VPN, чем незаметно отправить трафик через другой маршрут.
        if (restoredSelection.status === "unavailable" && restoredSelection.tag !== "auto") {
          const error = new Error("Remembered server is no longer present in the active subscription");
          error.code = "REMEMBERED_SELECTION_UNAVAILABLE";
          throw error;
        }
''',
    '''        if (restoredSelection.status === "reset") {
          const reason = restoredSelection.reason || "remembered_selection_reset";
          console.warn("remembered proxy selection reset", reason);
          if (operationToken?.kind === "sourceSwitch") {
            logSourceSwitchReconnect("selection", operationToken, "reset", reason);
          }
        }
        // This remains fatal only when the runtime selector itself has no
        // explicit automatic recovery route. No arbitrary child is selected.
        if (restoredSelection.status === "unavailable") {
          const error = new Error("Active selector has no valid recovery route");
          error.code = "SELECTION_POLICY_UNAVAILABLE";
          throw error;
        }
''',
)

regex_replace_once(
    "src-tauri/src/vpn.rs",
    r'''#\[tauri::command\]\npub async fn set_system_proxy\(.*?\n\}\n\n#\[tauri::command\]\npub async fn verify_runtime_endpoint\(''',
    r'''fn validate_system_proxy_enable_request(
    host_port: &str,
    expected_generation: u64,
) -> Result<(), String> {
    if host_port.trim().is_empty() {
        return Err("system proxy enable requires the current probe endpoint".into());
    }
    if expected_generation == 0 {
        return Err("system proxy enable requires the current process generation".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn enable_system_proxy(
    app: AppHandle,
    state: State<'_, SingboxState>,
    host_port: String,
    bypass_lan: Option<bool>,
    expected_generation: u64,
) -> Result<(), String> {
    validate_system_proxy_enable_request(&host_port, expected_generation)?;
    if let Err(error) = enable_system_proxy_for_runtime(
        &state,
        host_port.trim(),
        bypass_lan,
        Some(expected_generation),
    )
    .await
    {
        let cleanup = stop_singbox_inner(&app, &state, true, false).await;
        return Err(match cleanup {
            Ok(_) => format!("{error}; runtime stopped after proxy readiness failure"),
            Err(cleanup_error) => {
                format!(
                    "{error}; runtime stop after proxy readiness failure failed: {cleanup_error}"
                )
            }
        });
    }
    Ok(())
}

#[tauri::command]
pub fn disable_system_proxy() -> Result<(), String> {
    proxy::set_system_proxy(false, None, None)
}

#[cfg(test)]
mod system_proxy_command_tests {
    use super::validate_system_proxy_enable_request;

    #[test]
    fn enable_contract_requires_endpoint_and_generation() {
        assert!(validate_system_proxy_enable_request("", 1).is_err());
        assert!(validate_system_proxy_enable_request("127.0.0.1:7890", 0).is_err());
        assert!(validate_system_proxy_enable_request("127.0.0.1:7890", 1).is_ok());
    }
}

#[tauri::command]
pub async fn verify_runtime_endpoint(''',
)

replace_once(
    "src-tauri/src/lib.rs",
    '''            vpn::set_system_proxy,
''',
    '''            vpn::enable_system_proxy,
            vpn::disable_system_proxy,
''',
)


# ---------------------------------------------------------------------------
# 3. The exact geo-provider timeout in the supplied log is non-fatal telemetry.
# ---------------------------------------------------------------------------
replace_once(
    "src/lib/log-severity.js",
    '''  const expectedProviderFailure = /(\\b429\\b|\\b404\\b|non-200 response|EOF|server gave HTTP response to HTTPS client)/i.test(text);
''',
    '''  const expectedProviderFailure = /(\\b429\\b|\\b404\\b|non-200 response|EOF|context deadline exceeded|server gave HTTP response to HTTPS client)/i.test(text);
''',
)

replace_once(
    "tests/log-severity.test.mjs",
    '''test("real URL-test transport warnings retain warning severity", () => {
''',
    '''test("sing-box geo provider deadline timeout remains visible but non-fatal", () => {
  assert.deepEqual(
    classifyEngineLogSeverity(
      "WARN",
      "monitoring: Failed try 2 to get IP info: https://api.my-ip.io/v2/ip.json: context deadline exceeded",
    ),
    { level: "INFO", grade: "info", nonFatal: true },
  );
});

test("real URL-test transport warnings retain warning severity", () => {
''',
)

print("Source-switch and mode transition patch applied successfully")
