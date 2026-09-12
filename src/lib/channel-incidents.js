// Ninety · переходы состояния канала → записи в ленте инцидентов.
//
// Движок качества зовёт onState на каждом тике: лента обязана хранить ПЕРЕХОДЫ,
// а не пробы. Логика вынесена из main.js, потому что ошибиться в ней легко, а
// видно это только через несколько дней наблюдений — ровно так и вышло с
// UNKNOWN: «нечем измерить» запоминалось как состояние канала и глушило
// следующий переход в GOOD. Обычнейшая цепочка «упало → проба не дотянулась →
// починилось» не писала ни одного ok, инцидент закрывался по таймауту, и в
// ленте он навсегда оставался «чем закончилось — неизвестно».
//
// Три исхода инцидента и кто их пишет:
//   ok  — observe(GOOD): восстановление подтверждено замером;
//   end — endSession(): сессия кончилась раньше замера (отключение, смена
//         источника, выключенное наблюдение);
//   ничего — замеры прекратились; тогда pause() хотя бы называет причину, по
//         которой исход остался неизвестным.

export const CHANNEL_SESSION_END_KINDS = {
  disconnected: "quality.endedByDisconnect",
  sourceChanged: "quality.endedBySourceChange",
  monitoringOff: "quality.endedByMonitoringOff",
};

export const CHANNEL_PAUSE_KINDS = {
  hostPressure: "quality.pausedHostPressure",
  lowDataMode: "quality.pausedLowData",
  probeSkipped: "quality.pausedProbeSkipped",
};

const DEGRADED = new Set(["SLOW", "STALLED"]);

// record(kind, {severity, params}) — запись в ленту;
// isAnyIncidentOpen() — открыт ли инцидент, который открыл не канал (смерть
//   ядра, провал восстановления): он тоже кончается вместе с сессией;
// sessionSurvives(reason) — правда ли, что сессия на самом деле продолжается
//   (внутренний реконнект гасит движок, но намерение пользователя остаётся
//   «подключено», и через секунды измерения возобновятся).
export function createChannelIncidentRecorder({
  record,
  isAnyIncidentOpen = () => false,
  sessionSurvives = () => false,
} = {}) {
  if (typeof record !== "function") {
    throw new TypeError("channel incident recorder requires a record function");
  }

  let channelState = null;
  let pauseReason = null;

  const isOpen = () => DEGRADED.has(channelState);

  function observe(st) {
    // UNKNOWN — отказ измерения, а не состояние канала: историю не трогает.
    if (st === "UNKNOWN" || st === channelState) return null;
    const prev = channelState;
    channelState = st;
    // Канал сменил состояние — прежняя причина паузы больше не описывает
    // происходящее, и следующую надо записать заново.
    pauseReason = null;
    if (st === "GOOD") {
      return prev ? record("quality.restored", { severity: "ok", params: { from: prev } }) : null;
    }
    // Инцидент открываем и на первом замере сессии: канал, плохой сразу после
    // подключения, — ровно то, что пользователь должен видеть в ленте.
    if (!prev || prev === "GOOD") {
      return record("quality.degraded", {
        severity: st === "STALLED" ? "err" : "warn",
        params: { state: st },
      });
    }
    return null;
  }

  // Измерения прекратились по известной причине. Пишем только внутрь открытого
  // инцидента и только на смене причины: иначе лента забилась бы одинаковыми
  // строками с каждого тика сторожа.
  function pause(reason) {
    const kind = CHANNEL_PAUSE_KINDS[reason];
    if (!kind || !isOpen() || pauseReason === reason) return null;
    pauseReason = reason;
    return record(kind, { severity: "info", params: { reason } });
  }

  function endSession(reason) {
    if (sessionSurvives(reason)) return null;
    const open = isOpen() || isAnyIncidentOpen();
    // Состояние прошлой сессии не должно перетекать в следующую: после
    // подключения первый замер — это новая база, а не продолжение старой.
    channelState = null;
    pauseReason = null;
    if (!open) return null;
    return record(CHANNEL_SESSION_END_KINDS[reason] || CHANNEL_SESSION_END_KINDS.disconnected, {
      severity: "end",
      params: { reason },
    });
  }

  return { observe, pause, endSession, isOpen, state: () => channelState };
}
