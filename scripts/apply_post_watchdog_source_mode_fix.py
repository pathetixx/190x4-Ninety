from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def write(path: str, content: str) -> None:
    target = ROOT / path
    target.write_text(content, encoding="utf-8", newline="\n")


def replace_once(path: str, old: str, new: str) -> None:
    content = read(path)
    count = content.count(old)
    if count != 1:
        raise RuntimeError(f"{path}: expected one replacement, found {count}: {old[:160]!r}")
    write(path, content.replace(old, new, 1))


def replace_count(path: str, old: str, new: str, expected: int) -> None:
    content = read(path)
    count = content.count(old)
    if count != expected:
        raise RuntimeError(f"{path}: expected {expected} replacements, found {count}: {old[:160]!r}")
    write(path, content.replace(old, new))


def regex_replace_once(path: str, pattern: str, replacement: str) -> None:
    content = read(path)
    updated, count = re.subn(pattern, replacement, content, count=1, flags=re.S | re.M)
    if count != 1:
        raise RuntimeError(f"{path}: regex replacement count={count}: {pattern[:160]!r}")
    write(path, updated)


# Frontend: one adapter owns the Tauri wire contract.
replace_once(
    "src/main.js",
    'import { getRememberedProxySelection, restoreRememberedProxySelection } from "/lib/proxy-selection.js";\n',
    'import { getRememberedProxySelection, restoreRememberedProxySelection } from "/lib/proxy-selection.js";\nimport { disableSystemProxy, enableSystemProxy } from "/lib/system-proxy-runtime.js";\n',
)

replace_count(
    "src/main.js",
    'try { await invoke("set_system_proxy", { enable: false }); } catch {}',
    'try { await disableSystemProxy(invoke); } catch {}',
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
        // Fatal only when the selector has no explicit automatic recovery
        // route. Ordinary mode never substitutes an arbitrary child node.
        if (restoredSelection.status === "unavailable") {
          const error = new Error("Active selector has no valid recovery route");
          error.code = "SELECTION_POLICY_UNAVAILABLE";
          throw error;
        }
''',
)

# Rust: split the ambiguous command. Tauri no longer deserializes irrelevant
# hostPort/expectedGeneration fields for a disable request.
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
        let cleanup = stop_singbox_inner(&app, &state).await;
        return Err(match cleanup {
            Ok(_) => format!("{error}; runtime stopped after proxy readiness failure"),
            Err(cleanup_error) => format!(
                "{error}; runtime stop after proxy readiness failure failed: {cleanup_error}"
            ),
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
    "            vpn::set_system_proxy,\n",
    "            vpn::enable_system_proxy,\n            vpn::disable_system_proxy,\n",
)

# Contract audit: production frontend must not call the removed command.
main = read("src/main.js")
lib_rs = read("src-tauri/src/lib.rs")
vpn_rs = read("src-tauri/src/vpn.rs")
if 'invoke("set_system_proxy"' in main:
    raise RuntimeError("legacy set_system_proxy frontend call remains")
if "vpn::set_system_proxy" in lib_rs:
    raise RuntimeError("legacy set_system_proxy registration remains")
if "pub async fn set_system_proxy" in vpn_rs:
    raise RuntimeError("legacy set_system_proxy command remains")
if "recoverDataplane" in main or "onDataplaneFailed" in main:
    raise RuntimeError("aggressive dataplane recovery was reintroduced")

print("Post-watchdog source switch and mode patch applied successfully")
