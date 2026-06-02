// Ninety · паспорт сборки. Значения commit/date/core подставляет CI-шаг
// «Generate build-info» (build.yml) ПЕРЕД `tauri build`, из реального git SHA,
// даты сборки (UTC) и пина ядра. В дев-окружении (без CI) — плейсхолдеры:
// версия всё равно берётся из рантайма (__TAURI__.app.getVersion), а паспорт
// показывает «—»/«local», чтобы не врать фиктивными значениями.
export const BUILD_INFO = {
  version: "0.1.59",          // дублирует tauri.conf; рантайм getVersion первичен
  commit: "local",            // git rev-parse --short HEAD (перезапишет CI)
  date: "—",                  // DD.MM.YYYY, дата сборки UTC (перезапишет CI)
  core: "sing-box 1.13.0",    // ядро hiddify-sing-box (тег v1.13.0.h5)
  channel: "Alpha",           // фаза проекта
  platform: "Windows · x64",
};
