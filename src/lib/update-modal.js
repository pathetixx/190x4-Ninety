// Ninety · Update modal controller
// Кастомная модалка вместо нативного dialog.ask — в стиле hub190x4-app Android.

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

function shouldSkip(version) {
  try { return localStorage.getItem(SKIP_KEY) === String(version); }
  catch { return false; }
}

function markSkipped(version) {
  try { localStorage.setItem(SKIP_KEY, String(version)); } catch {}
}

/**
 * Открыть модалку для апдейта.
 * @param {object} update — объект Tauri updater (currentVersion, version, body, downloadAndInstall)
 * @param {object} opts
 * @param {boolean} opts.respectSkip — если true и юзер ранее нажал "Позже" на эту версию, не показывать
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
  const actionsBox = $("update-actions");
  const laterBtn = $("update-later");
  const installBtn = $("update-install");

  if (!modal || !installBtn) return Promise.resolve();

  currentEl.textContent = update.currentVersion ?? "—";
  latestEl.textContent = update.version ?? "—";
  const body = (update.body || "").trim();
  // Если notes — наш дефолт-заглушка из workflow, заменяем на дружелюбное
  changelogEl.textContent = body && !/См\. полные заметки в GitHub Release/.test(body)
    ? body
    : "Заметки релиза недоступны. Открой страницу релиза на GitHub.";

  progressBox.hidden = true;
  showError(null);
  installBtn.disabled = false;
  laterBtn.disabled = false;
  laterBtn.hidden = false;
  installBtn.textContent = "ОБНОВИТЬ";
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
      showError(null);
      installBtn.disabled = true;
      laterBtn.hidden = true;
      progressBox.hidden = false;
      setProgressLabel("Загрузка");
      setBarIndeterminate();

      // Гасим ядра до установки: xray.exe / sing-box.exe держат бинарники
      // залоченными, NSIS-инсталлятор иначе падает на "файл занят". stop_singbox
      // снимает оба child'а + останавливает TUN-сервис. NSIS-хук — подстраховка.
      // DPI-обход: winws лочит свой бинарь И kernel-драйвер WinDivert (его служба
      // не выгружается со смертью процесса) → инсталлер падает. dpi_unload_driver
      // гасит winws и снимает службу WinDivert; аппа при запущенном DPI уже
      // elevated, поэтому sc-команды проходят. Запоминаем, что DPI был включён —
      // после перезапуска autostart-блок поднимет его обратно.
      const dpiWasOn = (() => {
        try { return localStorage.getItem("ninety.dpi.enabled") === "true"; } catch { return false; }
      })();
      const invoke = window.__TAURI__?.core?.invoke;
      if (invoke) {
        try { await invoke("set_system_proxy", { enable: false }); } catch {}
        try { await invoke("stop_singbox"); } catch (e) { console.warn("pre-update stop failed", e); }
        try { await invoke("dpi_unload_driver"); } catch (e) { console.warn("pre-update dpi unload failed", e); }
      }
      if (dpiWasOn) { try { localStorage.setItem("ninety.dpi.resumeAfterUpdate", "1"); } catch {} }

      let total = 0;
      let downloaded = 0;
      let lastPct = -1;

      try {
        await update.downloadAndInstall((ev) => {
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
            setProgressLabel("Установка…");
            setBarIndeterminate();
          }
        });

        setProgressLabel("Перезапуск…");
        const a = api();
        try { await a?.process?.relaunch(); }
        catch (e) { console.warn("relaunch failed", e); }
        // Если relaunch не сработал — даём юзеру закрыть руками
        installBtn.textContent = "ГОТОВО";
        installBtn.disabled = false;
        installBtn.addEventListener("click", close, { once: true });
      } catch (e) {
        console.error("update failed", e);
        installing = false;
        progressBox.hidden = true;
        showError(`Не удалось обновить: ${e?.message || e}`);
        installBtn.disabled = false;
        laterBtn.hidden = false;
        installBtn.textContent = "ПОВТОРИТЬ";
      }
    };

    installBtn.addEventListener("click", onInstall);
    laterBtn.addEventListener("click", onLater);
    backdrop.addEventListener("click", onBackdrop);
    document.addEventListener("keydown", onKey);
  });
}
