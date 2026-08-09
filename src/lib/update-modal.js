// Ninety · Update modal controller
// Кастомная модалка вместо нативного dialog.ask — в стиле hub190x4-app Android.

import { t } from "/lib/i18n/index.js";
import { closeUpdateResource, snapshotUpdate } from "/lib/update-resource.js";
import { formatReleaseNotes } from "/lib/release-notes.js";

const SKIP_KEY = "ninety.update.skip";
const RESUME_KEY = "ninety.update.resume";
const RELEASE_BASE_URL = "https://github.com/pathetixx/190x4-Ninety/releases/tag";
export const UPDATE_DOWNLOAD_TIMEOUT_MS = 15 * 60_000;

export function portableReleaseUrl(version) {
  return `${RELEASE_BASE_URL}/v${encodeURIComponent(String(version || ""))}`;
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
    // После начатой остановки неизвестное состояние нельзя выдавать за рабочее.
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

// Закрытие по Escape/клику мимо окна — не решение «эту версию не показывать».
// Раньше оба пути шли через «Позже» и писали версию в localStorage навсегда:
// один случайный Esc — и модалка по этой версии не появлялась уже никогда,
// хотя пользователь просто убрал окно с глаз. Держим такой отказ в памяти
// процесса: до перезапуска не навязываемся, после — предлагаем снова.
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
 * Открыть модалку для апдейта.
 * @param {object} update — объект Tauri updater (currentVersion, version, body, download/install)
 * @param {object} opts
 * @param {boolean} opts.respectSkip — если true и юзер ранее нажал "Позже" на эту версию, не показывать
 * @param {function} opts.onInstalling — (bool) идёт скачивание/установка; main.js
 *   по нему глушит health-watchdog (иначе тот находил «труп» ядра, которое мы
 *   сами погасили перед установкой, и слал ложный «соединение закрыто»).
 * @param {function} opts.onBeforeInstall — async-хук перед остановкой ядер;
 *   main.js сохраняет через него профиль и resume-маркер одним OTA-снимком.
 * @param {function} opts.onBeforeRuntimeStop — синхронный хук перед остановкой
 *   ядер; main.js инвалидирует reconnect-намерение до ухода в updater.
 * @returns Promise<void> — резолвится после закрытия (либо relaunch — резолва не будет, app перезапустится)
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
    // updater.install()/downloadAndInstall() уже удаляют update RID на Rust-
    // стороне. Повторный Resource.close() дал бы invalid-resource и ошибочно
    // отравил cleanup quarantine.
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
    // Если notes — наш дефолт-заглушка из workflow, заменяем на дружелюбное
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
  installBtn.textContent = opts.portable
    ? t("updModal.downloadPortable")
    : t("updModal.install");
  modal.hidden = false;

  return new Promise((resolve) => {
    let installing = false;
    let preparing = false;

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

    // Esc/фон закрывают окно, но не отказываются от версии насовсем.
    const onDismiss = () => {
      if (installing || preparing) return;
      markDismissed(activeUpdate.version);
      close();
    };

    const onBackdrop = () => { if (!installing) onDismiss(); };

    const onKey = (e) => {
      if (e.key === "Escape" && !installing) onDismiss();
    };

    const onInstall = async () => {
      if (installing || preparing) return;
      if (opts.portable) {
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

      // Pending в трее хранит только metadata. Настоящий Tauri Update получаем
      // непосредственно перед download: его HTTP client тогда использует
      // актуальное состояние VPN/proxy, а не маршрут часовой давности.
      preparing = true;
      opts.onInstalling?.(true);
      installBtn.disabled = true;
      showError(null);
      try {
        if (typeof opts.acquireUpdate === "function") {
          // Retry никогда не переиспользует старый HTTP client/download buffer.
          // Освобождаем его до fresh-check, сохраняя metadata для модалки.
          if (!(await releaseActiveResource())) {
            throw new Error(t("update.unavailable"));
          }
          const acquired = await opts.acquireUpdate();
          if (!acquired) throw new Error(t("update.none"));
          if (String(acquired.version) !== String(activeUpdate.version)) {
            activeUpdate = acquired;
            renderMetadata();
            opts.onVersionChanged?.(activeUpdate.version);
            await releaseActiveResource();
            showError(t("updModal.versionChanged", { version: activeUpdate.version }));
            preparing = false;
            opts.onInstalling?.(false);
            installBtn.disabled = false;
            installBtn.textContent = t("updModal.install");
            return;
          }
          activeUpdate = acquired;
          activeUpdateConsumed = false;
        }
        if (typeof activeUpdate.download !== "function"
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
        try { return localStorage.getItem("ninety.dpi.enabled") === "true"; } catch { return false; }
      })();
      const invoke = window.__TAURI__?.core?.invoke;
      // Что было поднято — запоминаем ДО гашения: после перезапуска
      // автоконнект-блок main.js читает ninety.update.resume и возвращает
      // сессию (раньше флаг был только про DPI — юзер с апдейтом при
      // выключенном DPI оставался отключённым, пока не нажмёт руками).
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

        // Recovery получает journal аргументом, поэтому marker можно закрыть до
        // хука. Тогда main.js::markUpdateRuntimeReady зафиксирует его отсутствие
        // через state-backup. При провале recovery marker возвращаем.
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

      // Гасим ядра ПЕРЕД установкой, но ПОСЛЕ скачивания: разлоченные бинарники
      // нужны NSIS только на этапе install, а пока качаем — туннель жив (и
      // download через check({proxy}) идёт по нему; гасить раньше = качать
      // напрямую там, где напрямую не качается). stop_singbox снимает оба
      // child'а; winws лочит свой бинарь И kernel-драйвер WinDivert (служба не
      // выгружается со смертью процесса) → dpi_unload_driver гасит winws и
      // снимает службу; аппа при запущенном DPI уже elevated, sc-команды пройдут.
      const stopEngines = async () => {
        opts.onBeforeRuntimeStop?.();
        if (!invoke) return null;
        // Состояние VPN перечитываем прямо здесь. Первый снимок берётся при
        // клике «Обновить», а между ним и остановкой проходит всё скачивание:
        // подключение, которое в тот момент только устанавливалось, попадало в
        // журнал как выключенное и после перезапуска не возвращалось.
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
        if (typeof activeUpdate.download === "function"
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
          // На Windows успешный install() не возвращается: plugin передаёт
          // управление NSIS (/P /R) и завершает процесс. Всё durable уже записано.
          await activeUpdate.install();
          activeUpdateConsumed = true;
        } else {
          // Урезанный API (нет раздельных download/install) — прежний порядок.
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
          // install уже завершён, поэтому повторная кнопка «Установить» не
          // восстановит состояние. Сохраняем журнал и сразу отдаём управление
          // recovery-хуку: он либо возвращает VPN/DPI в рабочее состояние, либо
          // оставляет приложение в честном idle/cleanup_error.
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
          // Установка уже завершена: retry здесь не имеет смысла, а исходный
          // onInstall нельзя оставлять рядом с кнопкой закрытия.
          cleanup();
          installBtn.disabled = false;
          installBtn.textContent = t("updModal.done");
          installBtn.addEventListener("click", close, { once: true });
          return;
        }
        // После подтверждённого relaunch старый процесс скоро завершится;
        // journal будет закрыт новым bootstrap только после RuntimeReady.
        installBtn.textContent = t("updModal.done");
        installBtn.disabled = false;
        installBtn.addEventListener("click", close, { once: true });
      } catch (e) {
        console.error("update failed", e);
        // До остановки runtime рабочую сессию не трогаем и закрываем только
        // незавершённый OTA marker. После начатого stop recovery запускается лишь
        // когда желаемые движки реально уже не готовы.
        try { await recoverOrCloseJournal(e); } catch (recoveryError) {
          console.warn("update recovery failed", recoveryError);
        }
        // Retry всё равно делает fresh-check: не держим старый client и
        // installer-sized DownloadedBytes между попытками.
        await releaseActiveResource();
        installing = false;
        opts.onInstalling?.(false);
        progressBox.hidden = true;
        showError(t("updModal.failed", { err: e?.message || e }));
        installBtn.disabled = false;
        laterBtn.hidden = false;
        installBtn.textContent = t("updModal.retry");
      }
    };

    installBtn.addEventListener("click", onInstall);
    laterBtn.addEventListener("click", onLater);
    backdrop.addEventListener("click", onBackdrop);
    document.addEventListener("keydown", onKey);
  });
}
