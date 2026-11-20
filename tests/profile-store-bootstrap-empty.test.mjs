// Свежая установка (exists:false): профиль, добавленный, пока profile_store_load
// ещё в полёте, не должен теряться.
import { test } from "node:test";
import assert from "node:assert/strict";

function makeStorage() {
  const data = new Map();
  return {
    get length() { return data.size; },
    key: (i) => Array.from(data.keys())[i] ?? null,
    getItem: (k) => data.has(k) ? data.get(k) : null,
    setItem: (k, v) => data.set(k, String(v)),
    removeItem: (k) => data.delete(k),
    clear: () => data.clear(),
  };
}
globalThis.localStorage = makeStorage();
globalThis.window = {};
globalThis.dispatchEvent = () => true;
globalThis.CustomEvent = class { constructor(t, i) { this.type = t; this.detail = i?.detail; } };

let releaseLoad;
const gate = new Promise(r => { releaseLoad = r; });
const replaceCalls = [];
const invoke = async (cmd, args) => {
  if (cmd === "profile_store_load") { await gate; return { exists: false, schemaVersion: 1, revision: 0, recoveredFromBackup: false, store: null }; }
  if (cmd === "profile_store_replace") { replaceCalls.push(args); return { revision: args.expectedRevision + 1 }; }
  throw new Error(cmd);
};
const s = await import("/lib/profile-store.js");

test("ранний профиль на пустом сторе сохраняется", async () => {
  const init = s.initializeProfileStore({ invoke, storage: globalThis.localStorage });
  s.saveProfilesToStore([{ id: "p-early", name: "early", host: "5.6.7.8", port: 443 }]);
  releaseLoad();
  await init;
  // следующая мутация пользователя
  s.saveProfilesToStore([...s.loadProfilesFromStore(), { id: "p-next", name: "n", host: "9.9.9.9", port: 443 }]);
  await new Promise(r => setTimeout(r, 20));
  assert.ok(s.loadProfilesFromStore().some(p => p.id === "p-early"), "p-early потерян");
  assert.deepEqual(replaceCalls.at(-1)?.store.profiles.map(p => p.id), ["p-early", "p-next"]);
});
