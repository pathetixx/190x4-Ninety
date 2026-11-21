// Ninety · deciding "how to show a found update".
//
// Moved out of main.js because exactly this branch is responsible for the only
// visible sign of OTA when the window is minimized to the tray. While it lived inline among
// four awaits, it could neither be run in a test nor proven that the user
// would see anything at all in the tray.
//
// Invariants:
//   * a found update ALWAYS becomes pending — i.e. gets into the menu and
//     the tray tooltip. Neither "Later", nor a failed cleanup of the Rust resource, nor a repeated
//     check has the right to erase this passive sign: it imposes nothing
//     and costs one menu item;
//   * the modal is allowed only when the window is actually in front of the user or they
//     pressed "Check for updates" themselves;
//   * the OS notification — once per version per session and only in the background.

export const UPDATE_NOTICE = {
  MODAL: "modal",
  NOTIFY: "notify",
  TRAY: "tray",
};

/**
 * @param {object} input
 * @param {boolean} input.interactive   — the user pressed "Check" themselves.
 * @param {boolean} input.skipped       — "Later" was already pressed for this version.
 * @param {boolean} input.foreground    — the window is visible, not minimized and focused.
 * @param {boolean} input.alreadyNotified — an OS notification for this version was already sent.
 * @param {boolean} input.modalBusy     — the modal for this same version is already open.
 * @returns {{ pending: boolean, action: string, reason: string }}
 */
export function planUpdateNotice({
  interactive = false,
  skipped = false,
  foreground = false,
  alreadyNotified = false,
  modalBusy = false,
} = {}) {
  // A manual check outranks everything: the user is looking at the window and waiting for an answer,
  // they have just re-asked about the version they said "Later" to.
  if (interactive) return { pending: true, action: UPDATE_NOTICE.MODAL, reason: "interactive" };
  if (modalBusy) return { pending: true, action: UPDATE_NOTICE.TRAY, reason: "modal_open" };
  // "Later" mutes the intrusive part (the modal and the notification), but not the passive one:
  // an accidental Esc must not pretend there's no update.
  if (skipped) return { pending: true, action: UPDATE_NOTICE.TRAY, reason: "skipped" };
  if (foreground) return { pending: true, action: UPDATE_NOTICE.MODAL, reason: "foreground" };
  if (alreadyNotified) return { pending: true, action: UPDATE_NOTICE.TRAY, reason: "already_notified" };
  return { pending: true, action: UPDATE_NOTICE.NOTIFY, reason: "background" };
}
