// Ninety · решение «как показать найденный апдейт».
//
// Вынесено из main.js, потому что именно эта развилка отвечает за единственный
// видимый признак OTA, когда окно свёрнуто в трей. Пока она жила инлайном среди
// четырёх await'ов, её нельзя было ни прогнать тестом, ни доказать, что в трее
// пользователь вообще что-то увидит.
//
// Инварианты:
//   * найденный апдейт ВСЕГДА становится pending — то есть попадает в меню и
//     подсказку трея. Ни «Позже», ни неудачная уборка Rust-ресурса, ни повторная
//     проверка не имеют права стереть этот пассивный признак: он ничего не
//     навязывает и стоит один пункт меню;
//   * модалку разрешаем только когда окно реально перед пользователем либо он
//     сам нажал «Проверить обновления»;
//   * OS-уведомление — один раз на версию за сессию и только в фоне.

export const UPDATE_NOTICE = {
  MODAL: "modal",
  NOTIFY: "notify",
  TRAY: "tray",
};

/**
 * @param {object} input
 * @param {boolean} input.interactive   — пользователь сам нажал «Проверить».
 * @param {boolean} input.skipped       — по этой версии уже нажимали «Позже».
 * @param {boolean} input.foreground    — окно видимо, не свёрнуто и в фокусе.
 * @param {boolean} input.alreadyNotified — OS-уведомление по этой версии уже слали.
 * @param {boolean} input.modalBusy     — модалка этой же версии уже открыта.
 * @returns {{ pending: boolean, action: string, reason: string }}
 */
export function planUpdateNotice({
  interactive = false,
  skipped = false,
  foreground = false,
  alreadyNotified = false,
  modalBusy = false,
} = {}) {
  // Ручная проверка старше всего: пользователь смотрит на окно и ждёт ответа,
  // «Позже» по этой версии он только что сам и переспросил.
  if (interactive) return { pending: true, action: UPDATE_NOTICE.MODAL, reason: "interactive" };
  if (modalBusy) return { pending: true, action: UPDATE_NOTICE.TRAY, reason: "modal_open" };
  // «Позже» гасит навязчивую часть (модалку и уведомление), но не пассивную:
  // случайный Esc не должен делать вид, что обновления нет.
  if (skipped) return { pending: true, action: UPDATE_NOTICE.TRAY, reason: "skipped" };
  if (foreground) return { pending: true, action: UPDATE_NOTICE.MODAL, reason: "foreground" };
  if (alreadyNotified) return { pending: true, action: UPDATE_NOTICE.TRAY, reason: "already_notified" };
  return { pending: true, action: UPDATE_NOTICE.NOTIFY, reason: "background" };
}
