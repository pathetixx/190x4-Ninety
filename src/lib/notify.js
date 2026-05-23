// Ninety · нативные уведомления Windows через tauri-plugin-notification.
// Используем глобальные __TAURI__.notification (withGlobalTauri:true).

const api = () => window.__TAURI__?.notification;

let ensured = false;
async function ensurePermission() {
  const a = api();
  if (!a) return false;
  if (ensured) return true;
  try {
    let granted = await a.isPermissionGranted?.();
    if (!granted && a.requestPermission) {
      const r = await a.requestPermission();
      granted = r === "granted";
    }
    ensured = !!granted;
    return ensured;
  } catch { return false; }
}

export async function notify(title, body) {
  try {
    const a = api();
    if (!a) return;
    const ok = await ensurePermission();
    if (!ok) return;
    a.sendNotification?.({ title, body });
  } catch (e) {
    console.warn("notify failed", e?.message);
  }
}
