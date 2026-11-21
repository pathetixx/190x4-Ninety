// Ninety · Update modal controller
// A custom modal instead of the native dialog.ask — in the style of hub190x4-app Android.

import { t } from "/lib/i18n/index.js";
import { closeUpdateResource, snapshotUpdate } from "/lib/update-resource.js";
import { formatReleaseNotes } from "/lib/release-notes.js";
import { STORAGE_KEYS } from "/lib/storage-policy.js";
import { localizedInvoke, localizeBackendText } from "/lib/backend-errors.js";

const SKIP_KEY = STORAGE_KEYS.updateSkip;
const RESUME_KEY = STORAGE_KEYS.updateResume;
const RELEASE_BASE_URL = "https://github.com/pathetixx/190x4-Ninety/releases/tag";
export const UPDATE_DOWNLOAD_TIMEOUT_MS = 15 * 60_000;

export function portableReleaseUrl(version) {
  return `${RELEASE_BASE_URL}/v${encodeURIComponent(String(version || ""))}`;
}

// The version in latest.json changed between the notification and "Update": Rust answers
// with the updModal.versionChanged token with the new version (portable_update.rs). We recognize
// it before translation — otherwise it would become a regular error, and the fallback button would open
// the release page of the previous version.
const VERSION_CHANGED_TOKEN = /\[\[updModal\.versionChanged (\{.*?\})\]\]/;

export function portableVersionChange(error) {
  const text = typeof error === "string" ? error : String(error?.message ?? "");
  const match = VERSION_CHANGED_TOKEN.exec(text);
  if (!match) return null;
  try {
    const version = JSON.parse(match[1])?.version;
    return typeof version === "string" && version ? version : null;
  } catch {
    return null;
  }
}

export function buildUpdateJournal({ targetVersion, stage, sourceFingerprint, mode, vpn, dpi, attempts = 1 }) {
  return {
    schemaVersion: 2,
    targetVersion: targetVersion || null,
    stage,
    sourceFingerprint: sourceFingerprint || null,
    mode: mode || null,
    desired: { vpn: !!vpn, dpi: !!dpi },
    attempts: Math.max(1, Number(attempts) || 1),
    updatedAt: Date.now(),
  };
}

export function persistUpdateJournal(journal, storage = localStorage) {
  const encoded = JSON.stringify(journal);
  storage.setItem(RESUME_KEY, encoded);
  if (storage.getItem(RESUME_KEY) !== encoded) {
    throw new Error("OTA resume journal verification failed");
  }
  return encoded;
}

export function clearUpdateJournal(storage = localStorage) {
  storage.removeItem(RESUME_KEY);
  if (storage.getItem(RESUME_KEY) !== null) {
    throw new Error("OTA resume journal cleanup verification failed");
  }
}

export function resumeRuntimeReady(resume, { vpnReady, dpiReady }, storage = globalThis.localStorage) {
  const desired = resume?.schemaVersion === 2 ? resume.desired : resume;
  const ready = (!desired?.vpn || vpnReady === true) && (!desired?.dpi || dpiReady === true);
  if (!ready || !storage) return ready;
  try {
    if (storage.getItem(RESUME_KEY) != null) clearUpdateJournal(storage);
    return true;
  } catch (e) {
    console.warn("OTA resume journal cleanup failed", e);
    return false;
  }
}

export async function updateRecoveryRequired(journal, invoke, runtimeStopAttempted = false) {
  if (!journal || !runtimeStopAttempted || typeof invoke !== "function") return false;
  const desired = journal?.schemaVersion === 2 ? journal.desired : journal;
  try {
    const snapshot = desired?.vpn ? await invoke("runtime_snapshot") : null;
    const vpnReady = !desired?.vpn || (
      snapshot?.running === true
      && snapshot?.clashReady !== false
      && snapshot?.sidecars?.xray !== "died"
      && snapshot?.sidecars?.clients !== "died"
    );
    const dpiReady = !desired?.dpi || !!(await invoke("dpi_running"));
    return !(vpnReady && dpiReady);
  } catch {
    // Once a stop has started, an unknown state must not be passed off as a working one.
    return true;
  }
}

function $(id) { return document.getElementById(id); }

function api() {
  const root = window.__TAURI__;
  if (!root) return null;
  return {
    updater: root.updater,
    process: root.process,
  };
}

function setBarPct(pct) {
  const bar = $("update-bar");
  const pctEl = $("update-progress-pct");
  if (!bar || !pctEl) return;
  bar.style.width = `${Math.max(0, Math.min(100, pct))}%`;
  bar.classList.remove("update-modal__bar-fill--indeterminate");
  pctEl.textContent = `${Math.round(pct)}%`;
}

function setBarIndeterminate() {
  const bar = $("update-bar");
  const pctEl = $("update-progress-pct");
  if (!bar || !pctEl) return;
  bar.classList.add("update-modal__bar-fill--indeterminate");
  bar.style.width = "35%";
  pctEl.textContent = "…";
}

function setProgressLabel(text) {
  const label = $("update-progress-label");
  if (label) label.textContent = text;
}

function showError(msg) {
  const err = $("update-error");
  if (!err) return;
  if (msg) {
    err.textContent = msg;
    err.hidden = false;
  } else {
    err.hidden = true;
    err.textContent = "";
  }
}

// Closing with Escape/a click outside the window isn't a "don't show this version" decision.
// Previously both paths went through "Later" and wrote the version to localStorage forever:
// one accidental Esc — and the modal for this version never appeared again,
// although the user just moved the window out of sight. We keep such a refusal in the process's
// memory: until a restart we don't impose, after it we offer again.
const dismissedThisSession = new Set();

export function shouldSkip(version) {
  const v = String(version);
  if (dismissedThisSession.has(v)) return true;
  try { return localStorage.getItem(SKIP_KEY) === v; }
  catch { return false; }
}

function markSkipped(version) {
  try { localStorage.setItem(SKIP_KEY, String(version)); } catch {}
}

function markDismissed(version) {
  dismissedThisSession.add(String(version));
}

/**
 * Open the modal for an update.
 * @param {object} update — the Tauri updater object (currentVersion, version, body, download/install)
 * @param {object} opts
 * @param {boolean} opts.respectSkip — if true and the user previously pressed "Later" on this version, don't show
 * @param {function} opts.onInstalling — (bool) downloading/installing is in progress; main.js
 *   uses it to mute the health watchdog (otherwise it found the "corpse" of the core that we
 *   stopped ourselves before installing, and sent a false "connection closed").
 * @param {function} opts.onBeforeInstall — an async hook before stopping the cores;
 *   main.js uses it to save the profile and the resume marker in one OTA snapshot.
 * @param {function} opts.onBeforeRuntimeStop — a synchronous hook before stopping
 *   the cores; main.js invalidates the reconnect intent before handing over to the updater.
 * @returns Promise<void> — resolves after closing (or relaunch — there will be no resolve, the app restarts)
 */
export function openUpdateModal(update, opts = {}) {
  if (!update) return Promise.resolve();
  if (opts.respectSkip && shouldSkip(update.version)) {
    void closeUpdateResource(update);
    return Promise.resolve();
  }

  const modal = $("update-modal");
  const backdrop = $("update-backdrop");
  const currentEl = $("update-current");
  const latestEl = $("update-latest");
  const changelogEl = $("update-changelog");
  const progressBox = $("update-progress");
  const laterBtn = $("update-later");
  const installBtn = $("update-install");

  if (!modal || !installBtn) {
    void closeUpdateResource(update);
    return Promise.resolve();
  }

  let activeUpdate = update;
  let activeUpdateConsumed = false;
  const releaseActiveResource = async () => {
    if (typeof activeUpdate?.close !== "function") return true;
    const resource = activeUpdate;
    const metadata = snapshotUpdate(resource);
    // updater.install()/downloadAndInstall() already delete the update RID on the Rust
    // side. A repeated Resource.close() would produce invalid-resource and wrongly
    // poison the cleanup quarantine.
    if (activeUpdateConsumed) {
      activeUpdate = metadata;
      activeUpdateConsumed = false;
      return true;
    }
    const released = await closeUpdateResource(resource);
    if (released) activeUpdate = metadata;
    return released;
  };
  const renderMetadata = () => {
    currentEl.textContent = activeUpdate.currentVersion ?? "—";
    latestEl.textContent = activeUpdate.version ?? "—";
    const body = (activeUpdate.body || "").trim();
    // If the notes are our default placeholder from the workflow, we replace them with a friendly
    changelogEl.textContent = body && !/См\. полные заметки в GitHub Release/.test(body)
      ? formatReleaseNotes(body)
      : t("updModal.notesUnavailable");
  };
  renderMetadata();

  progressBox.hidden = true;
  showError(null);
  installBtn.disabled = false;
  laterBtn.disabled = false;
  laterBtn.hidden = false;
  installBtn.textContent = t("updModal.install");
  modal.hidden = false;

  return new Promise((resolve) => {
    let installing = false;
    let preparing = false;
    // Portable updates itself; if it didn't work, the next button leads to
    // the release page for the ZIP, as before.
    let portableFallback = false;

    const cleanup = () => {
      installBtn.removeEventListener("click", onInstall);
      laterBtn.removeEventListener("click", onLater);
      backdrop.removeEventListener("click", onBackdrop);
      document.removeEventListener("keydown", onKey);
    };
    const close = () => {
      modal.hidden = true;
      cleanup();
      void releaseActiveResource();
      resolve();
    };

    const onLater = () => {
      if (installing || preparing) return;
      markSkipped(activeUpdate.version);
      close();
    };

    // Esc/the backdrop close the window, but don't give up on the version for good.
    const onDismiss = () => {
      if (installing || preparing) return;
      markDismissed(activeUpdate.version);
      close();
    };

    const onBackdrop = () => { if (!installing) onDismiss(); };

    const onKey = (e) => {
      if (e.key === "Escape" && !installing) onDismiss();
    };

    // One version was confirmed, but latest.json already has another: we show the new one and
    // wait for "Update" again, the window is free again. A shared path for
    // the installer and portable.
    const applyVersionChange = async (next) => {
      activeUpdate = next;
      activeUpdateConsumed = false;
      renderMetadata();
      opts.onVersionChanged?.(activeUpdate.version);
      await releaseActiveResource();
      preparing = false;
      installing = false;
      opts.onInstalling?.(false);
      progressBox.hidden = true;
      laterBtn.hidden = false;
      installBtn.disabled = false;
      installBtn.textContent = t("updModal.install");
      showError(t("updModal.versionChanged", { version: activeUpdate.version }));
    };

    // For portable Rust checks the version, and the new version's notes are taken with a fresh
    // check, as for the installer. If that fails — the new version without notes: old
    // notes under a new number would be misleading.
    const portableMetadata = async (version) => {
      try {
        // The previous Resource is released in any case, before the fresh check.
        const released = await releaseActiveResource();
        if (released && typeof opts.acquireUpdate === "function") {
          const acquired = await opts.acquireUpdate();
          if (acquired && String(acquired.version) === version) return acquired;
          if (acquired) void closeUpdateResource(acquired);
        }
      } catch (e) {
        console.warn("update notes refresh failed", e);
      }
      return { ...snapshotUpdate(activeUpdate), version, body: "" };
    };

    const onInstall = async () => {
      if (installing || preparing) return;
      if (opts.portable && portableFallback) {
        try {
          const open = window.__TAURI__?.shell?.open;
          if (typeof open !== "function") throw new Error(t("updModal.browserUnavailable"));
          await open(portableReleaseUrl(activeUpdate.version));
          markSkipped(activeUpdate.version);
          close();
        } catch (e) {
          showError(t("updModal.failed", { err: e?.message || e }));
        }
        return;
      }

      // The pending entry in the tray stores only metadata. The real Tauri Update is obtained
      // right before the download: its HTTP client then uses
      // the current VPN/proxy state, not an hour-old route.
      preparing = true;
      opts.onInstalling?.(true);
      installBtn.disabled = true;
      showError(null);
      try {
        if (!opts.portable && typeof opts.acquireUpdate === "function") {
          // A retry never reuses the old HTTP client/download buffer.
          // We release it before the fresh check, keeping the metadata for the modal.
          if (!(await releaseActiveResource())) {
            throw new Error(t("update.unavailable"));
          }
          const acquired = await opts.acquireUpdate();
          if (!acquired) throw new Error(t("update.none"));
          if (String(acquired.version) !== String(activeUpdate.version)) {
            await applyVersionChange(acquired);
            return;
          }
          activeUpdate = acquired;
          activeUpdateConsumed = false;
        }
        if (!opts.portable
          && typeof activeUpdate.download !== "function"
          && typeof activeUpdate.downloadAndInstall !== "function") {
          throw new Error(t("update.unavailable"));
        }
      } catch (e) {
        await releaseActiveResource();
        preparing = false;
        opts.onInstalling?.(false);
        installBtn.disabled = false;
        showError(t("updModal.failed", { err: e?.message || e }));
        return;
      }
      preparing = false;
      installing = true;
      showError(null);
      installBtn.disabled = true;
      laterBtn.hidden = true;
      progressBox.hidden = false;
      setProgressLabel(t("updModal.downloading"));
      setBarIndeterminate();

      const dpiWasOn = (() => {
        try { return localStorage.getItem(STORAGE_KEYS.dpiEnabled) === "true"; } catch { return false; }
      })();
      const invoke = localizedInvoke(window.__TAURI__?.core?.invoke);
      // What was up — we remember it BEFORE stopping: after the restart
      // main.js's autoconnect block reads ninety.update.resume and restores
      // the session (previously the flag was only about DPI — a user updating with
      // DPI off stayed disconnected until they pressed it by hand).
      let vpnWasOn = false;
      if (invoke) { try { vpnWasOn = !!(await invoke("singbox_running")); } catch {} }
      let journal = null;
      let runtimeStopAttempted = false;
      const journalAttempt = (() => {
        try { return (Number(JSON.parse(localStorage.getItem(RESUME_KEY) || "null")?.attempts) || 0) + 1; }
        catch { return 1; }
      })();
      const writeResume = (stage) => {
        if (!vpnWasOn && !dpiWasOn) return;
        journal = buildUpdateJournal({
          targetVersion: activeUpdate.version,
          stage,
          sourceFingerprint: opts.resumeContext?.sourceFingerprint || null,
          mode: opts.resumeContext?.mode || null,
          vpn: vpnWasOn,
          dpi: dpiWasOn,
          attempts: journalAttempt,
        });
        persistUpdateJournal(journal);
      };

      const recoverOrCloseJournal = async (error) => {
        if (!journal) return false;
        const needsRecovery = await updateRecoveryRequired(journal, invoke, runtimeStopAttempted);
        if (!needsRecovery) {
          clearUpdateJournal();
          return true;
        }

        // Recovery gets the journal as an argument, so the marker can be closed before
        // the hook. Then main.js::markUpdateRuntimeReady records its absence
        // via state-backup. If recovery fails, we restore the marker.
        let markerCleared = false;
        try {
          clearUpdateJournal();
          markerCleared = true;
        } catch (clearError) {
          console.warn("OTA resume journal pre-recovery cleanup failed", clearError);
        }
        let recovered = false;
        try { recovered = (await opts.onRecovery?.(journal, error)) === true; }
        catch (recoveryError) { console.warn("update recovery failed", recoveryError); }
        if (!recovered && markerCleared) persistUpdateJournal(journal);
        if (!recovered) return false;
        try { return localStorage.getItem(RESUME_KEY) === null; }
        catch { return false; }
      };

      // We stop the cores BEFORE installing but AFTER downloading: unlocked binaries
      // are needed by NSIS only at the install stage, and while we download the tunnel is alive (and
      // the download via check({proxy}) goes through it; stopping earlier = downloading
      // directly where directly doesn't download). stop_singbox removes both
      // children; winws locks its binary AND the WinDivert kernel driver (the service isn't
      // unloaded with the process's death) → dpi_unload_driver kills winws and
      // removes the service; with DPI running the app is already elevated, the sc commands will go through.
      const stopEngines = async () => {
        opts.onBeforeRuntimeStop?.();
        if (!invoke) return null;
        // We reread the VPN state right here. The first snapshot is taken on
        // the "Update" click, and the whole download happens between it and the stop:
        // a connection that was just being established at that moment ended up in
        // the journal as off and didn't come back after the restart.
        try {
          if (!vpnWasOn && await invoke("singbox_running")) {
            vpnWasOn = true;
            writeResume(journal?.stage || "download");
          }
        } catch {}
        runtimeStopAttempted = true;
        const result = await invoke("stop_singbox");
        if (!result || result.portsReleased === false
          || result.processesExited === false
          || [result.singbox, result.xray, result.sidecars].includes("failed")
          || result.systemProxy === "failed") {
          console.warn("pre-update runtime shutdown unconfirmed", result);
          throw new Error("Не удалось подтверждённо остановить сетевые движки");
        }
        await invoke("dpi_unload_driver");
        opts.onRuntimeStopped?.(result);
        return result;
      };

      let total = 0;
      let downloaded = 0;
      let lastPct = -1;
      const onEvent = (ev) => {
        if (ev.event === "Started") {
          total = ev.data?.contentLength || 0;
          downloaded = 0;
          if (total > 0) setBarPct(0);
          else setBarIndeterminate();
        } else if (ev.event === "Progress") {
          downloaded += ev.data?.chunkLength || 0;
          if (total > 0) {
            const pct = (downloaded / total) * 100;
            if (Math.floor(pct) !== lastPct) {
              lastPct = Math.floor(pct);
              setBarPct(pct);
            }
          }
        } else if (ev.event === "Finished") {
          setBarPct(100);
          setProgressLabel(t("updModal.installing"));
          setBarIndeterminate();
        }
      };

      try {
        const downloadOptions = {
          timeout: opts.downloadTimeoutMs || UPDATE_DOWNLOAD_TIMEOUT_MS,
        };
        if (opts.portable) {
          // The ZIP is downloaded and signature-checked by the updater plugin on the Rust side;
          // program files change only after the engines stop, and on
          // success portable_update_apply doesn't return: the process has already been replaced
          // by the new version.
          const Channel = window.__TAURI__?.core?.Channel;
          const rawInvoke = window.__TAURI__?.core?.invoke;
          if (typeof rawInvoke !== "function" || typeof Channel !== "function") {
            throw new Error(t("update.unavailable"));
          }
          const channel = new Channel();
          channel.onmessage = onEvent;
          const version = String(activeUpdate.version);
          // Without localizedInvoke: the version change must be recognized by the token before translation.
          // The same deadline as for the installer: while the download runs, the window
          // is blocked, and a hung connection must not hold it forever.
          let changedTo = null;
          try {
            await rawInvoke("portable_update_download", {
              expectedVersion: version,
              proxy: opts.portableProxy?.() || null,
              timeoutMs: downloadOptions.timeout,
              onEvent: channel,
            });
          } catch (e) {
            changedTo = portableVersionChange(e);
            if (!changedTo) throw localizeBackendText(e);
          }
          if (changedTo) {
            await applyVersionChange(await portableMetadata(changedTo));
            return;
          }
          writeResume("downloaded");
          setProgressLabel(t("updModal.installing"));
          setBarIndeterminate();
          writeResume("backup_ready");
          await opts.onBeforeInstall?.();
          await stopEngines();
          writeResume("runtime_stopped");
          writeResume("installing");
          await invoke("portable_update_apply", { version });
          throw new Error(t("update.unavailable"));
        } else if (typeof activeUpdate.download === "function"
          && typeof activeUpdate.install === "function") {
          await activeUpdate.download(onEvent, downloadOptions);
          writeResume("downloaded");
          setProgressLabel(t("updModal.installing"));
          setBarIndeterminate();
          writeResume("backup_ready");
          await opts.onBeforeInstall?.();
          await stopEngines();
          writeResume("runtime_stopped");
          writeResume("installing");
          // On Windows a successful install() doesn't return: the plugin hands
          // control to NSIS (/P /R) and terminates the process. Everything durable is already written.
          await activeUpdate.install();
          activeUpdateConsumed = true;
        } else {
          // A trimmed API (no separate download/install) — the old order.
          writeResume("backup_ready");
          await opts.onBeforeInstall?.();
          await stopEngines();
          writeResume("installing");
          await activeUpdate.downloadAndInstall(onEvent, downloadOptions);
          activeUpdateConsumed = true;
        }

        setProgressLabel(t("updModal.relaunching"));
        const a = api();
        try {
          if (typeof a?.process?.relaunch !== "function") throw new Error("API перезапуска недоступен");
          await a?.process?.relaunch();
          writeResume("relaunch_confirmed");
        } catch (e) {
          // install has already finished, so a repeated "Install" button won't
          // restore the state. We keep the journal and immediately hand control to
          // the recovery hook: it either brings VPN/DPI back to a working state or
          // leaves the app in an honest idle/cleanup_error.
          console.warn("relaunch failed, running recovery", e);
          writeResume("relaunch_failed");
          let recovered = false;
          try { recovered = await recoverOrCloseJournal(e); }
          catch (recoveryError) { console.warn("relaunch recovery failed", recoveryError); }
          installing = false;
          opts.onInstalling?.(false);
          progressBox.hidden = true;
          if (recovered) {
            close();
            return;
          }
          showError(t("updModal.failed", { err: e?.message || e }));
          // The installation has already finished: a retry makes no sense here, and the original
          // onInstall must not be left next to the close button.
          cleanup();
          installBtn.disabled = false;
          installBtn.textContent = t("updModal.done");
          installBtn.addEventListener("click", close, { once: true });
          return;
        }
        // After a confirmed relaunch the old process will soon exit;
        // the journal will be closed by the new bootstrap only after RuntimeReady.
        installBtn.textContent = t("updModal.done");
        installBtn.disabled = false;
        installBtn.addEventListener("click", close, { once: true });
      } catch (e) {
        console.error("update failed", e);
        // Before the runtime stop we don't touch the working session and close only
        // the unfinished OTA marker. After a stop has started, recovery runs only
        // when the desired engines are actually no longer ready.
        try { await recoverOrCloseJournal(e); } catch (recoveryError) {
          console.warn("update recovery failed", recoveryError);
        }
        // A retry still does a fresh check: we don't keep the old client and the
        // installer-sized DownloadedBytes between attempts.
        await releaseActiveResource();
        installing = false;
        opts.onInstalling?.(false);
        progressBox.hidden = true;
        const failed = t("updModal.failed", { err: e?.message || e });
        showError(opts.portable ? `${failed} ${t("updModal.portableFallback")}` : failed);
        installBtn.disabled = false;
        laterBtn.hidden = false;
        if (opts.portable) portableFallback = true;
        installBtn.textContent = opts.portable ? t("updModal.downloadPortable") : t("updModal.retry");
      }
    };

    installBtn.addEventListener("click", onInstall);
    laterBtn.addEventListener("click", onLater);
    backdrop.addEventListener("click", onBackdrop);
    document.addEventListener("keydown", onKey);
  });
}
