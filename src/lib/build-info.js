// Ninety · паспорт сборки. Файл СГЕНЕРИРОВАН: scripts/gen-build-info.mjs
// собирает его из .github/pins.json (версии ядер и компонентов) и
// src-tauri/tauri.conf.json (версия приложения), а CI зовёт скрипт перед
// `tauri build`. Руками не править — правка уедет со следующей сборкой.
// В дев-дереве значения commit/date остаются плейсхолдерами: версия всё равно
// берётся из рантайма (__TAURI__.app.getVersion), а паспорт не врёт цифрами.
// Единственное поле для ручной правки — channel: генератор переносит его из
// предыдущей версии файла.
export const BUILD_INFO = {
  version: "0.6.0",
  commit: "local",
  date: "—",
  core: "sing-box 1.13.19-ninety.8",
  coreXray: "Xray 26.7.28",
  channel: "Early access",
  platform: "Windows · x64",
  components: {
    naive: "150.0.7871.63-1",
    trusttunnel: "1.0.49",
    wintun: "0.14.1",
  },
};
