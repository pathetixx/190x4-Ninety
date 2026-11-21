// Ninety · build passport. This file is GENERATED: scripts/gen-build-info.mjs
// builds it from .github/pins.json (core and component versions) and
// src-tauri/tauri.conf.json (app version), and CI calls the script before
// `tauri build`. Don't edit by hand — the edit will be lost with the next build.
// In the dev tree the commit/date values stay placeholders: the version is taken
// from the runtime anyway (__TAURI__.app.getVersion), and the passport doesn't lie with numbers.
// The only field for manual editing is channel: the generator carries it over from
// the previous version of the file.
export const BUILD_INFO = {
  version: "0.18.0",
  commit: "local",
  date: "—",
  core: "sing-box 1.14.3-ninety.8",
  coreXray: "Xray 26.11.9",
  channel: "Early access",
  platform: "Windows · x64",
  components: {
    naive: "154.0.8037.49-5",
    trusttunnel: "1.1.12",
    wintun: "0.14.1",
  },
};
