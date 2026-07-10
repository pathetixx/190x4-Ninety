// Ninety · Update modal controller
// Кастомная модалка вместо нативного dialog.ask — в стиле hub190x4-app Android.

import { t } from "/lib/i18n/index.js";

const SKIP_KEY = "ninety.update.skip";

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

export function shouldSkip(version) {
  try { return localStorage.getItem(SKIP_KEY) === String(version); }
  catch { return false; }
}

function markSkipped(version) {
  try { localStorage.setItem(SKIP_KEY, String(version)); } catch {}
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
 * @returns Promise<void> — резолвится после закрытия (либо relaunch — резолва не будет, app перезапустится)
 */
export function openUpdateModal(update, opts = {}) {
  if (!update) return Promise.resolve();
  if (opts.respectSkip && shouldSkip(update.version)) return Promise.resolve();

  const modal = $("update-modal");
  const backdrop = $("update-backdrop");
  const currentEl = $("update-current");
  const latestEl = $("update-latest");
  const changelogEl = $("update-changelog");
  const progressBox = $("update-progress");
  const laterBtn = $("update-later");
  const installBtn = $("update-install");

  if (!modal || !installBtn) return Promise.resolve();

  currentEl.textContent = update.currentVersion ?? "—";
  latestEl.textContent = update.version ?? "—";
  const body = (update.body || "").trim();
  // Если notes — наш дефолт-заглушка из workflow, заменяем на дружелюбное
  changelogEl.textContent = body && !/См\. полные заметки в GitHub Release/.test(body)
    ? body
    : t("updModal.notesUnavailable");

  progressBox.hidden = true;
  showError(null);
  installBtn.disabled = false;
  laterBtn.disabled = false;
  laterBtn.hidden = false;
  installBtn.textContent = t("updModal.install");
  modal.hidden = false;

  return new Promise((resolve) => {
    let installing = false;

    const cleanup = () => {
      installBtn.removeEventListener("click", onInstall);
      laterBtn.removeEventListener("click", onLater);
      backdrop.removeEventListener("click", onBackdrop);
      document.removeEventListener("keydown", onKey);
    };
    const close = () => {
      modal.hidden = true;
      cleanup();
      resolve();
    };

    const onLater = () => {
      if (installing) return;
      markSkipped(update.version);
      close();
    };

    const onBackdrop = () => { if (!installing) onLater(); };

    const onKey = (e) => {
      if (e.key === "Escape" && !installing) onLater();
    };

    const onInstall = async () => {
      if (installing) return;
      installing = true;
      opts.onInstalling?.(true);
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
      const writeResume = () => {
        if (!vpnWasOn && !dpiWasOn) return;
        try { localStorage.setItem("ninety.update.resume", JSON.stringify({ vpn: vpnWasOn, dpi: dpiWasOn })); } catch {}
      };

      // Гасим ядра ПЕРЕД установкой, но ПОСЛЕ скачивания: разлоченные бинарники
      // нужны NSIS только на этапе install, а пока качаем — туннель жив (и
      // download через check({proxy}) идёт по нему; гасить раньше = качать
      // напрямую там, где напрямую не качается). stop_singbox снимает оба
      // child'а; winws лочит свой бинарь И kernel-драйвер WinDivert (служба не
      // выгружается со смертью процесса) → dpi_unload_driver гасит winws и
      // снимает службу; аппа при запущенном DPI уже elevated, sc-команды пройдут.
      const stopEngines = async () => {
        if (!invoke) return;
        try { await invoke("set_system_proxy", { enable: false }); } catch {}
        try { await invoke("stop_singbox"); } catch (e) { console.warn("pre-update stop failed", e); }
        try { await invoke("dpi_unload_driver"); } catch (e) { console.warn("pre-update dpi unload failed", e); }
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
        if (typeof update.download === "function" && typeof update.install === "function") {
          await update.download(onEvent);
          setProgressLabel(t("updModal.installing"));
          setBarIndeterminate();
          writeResume();
          await opts.onBeforeInstall?.();
          await stopEngines();
          await update.install();
        } else {
          // Урезанный API (нет раздельных download/install) — прежний порядок.
          writeResume();
          await opts.onBeforeInstall?.();
          await stopEngines();
          await update.downloadAndInstall(onEvent);
        }

        setProgressLabel(t("updModal.relaunching"));
        const a = api();
        try { await a?.process?.relaunch(); }
        catch (e) { console.warn("relaunch failed", e); }
        // Если relaunch не сработал — даём юзеру закрыть руками
        installBtn.textContent = t("updModal.done");
        installBtn.disabled = false;
        installBtn.addEventListener("click", close, { once: true });
      } catch (e) {
        console.error("update failed", e);
        // Установка сорвалась — resume-флаг не должен сработать на следующем
        // обычном старте и внезапно поднять VPN/DPI.
        try { localStorage.removeItem("ninety.update.resume"); } catch {}
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
