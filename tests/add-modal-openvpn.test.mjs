import { test } from "node:test";
import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";
import { readFileSync } from "node:fs";

class FakeElement {
  constructor() {
    this.value = "";
    this.dataset = {};
    this.hidden = false;
    this.disabled = false;
    this.listeners = new Map();
    this.attributes = new Map();
  }
  addEventListener(type, fn) { this.listeners.set(type, [...(this.listeners.get(type) || []), fn]); }
  setAttribute(key, value) { this.attributes.set(key, value); }
  getAttribute(key) { return this.attributes.get(key); }
  focus() {}
  async dispatch(type, event = {}) {
    for (const fn of this.listeners.get(type) || []) await fn({ target: this, currentTarget: this, ...event });
  }
}

const elements = new Map([
  "add-modal", "add-modal-backdrop", "add-modal-close", "add-modal-cancel",
  "add-modal-url", "add-modal-name", "add-modal-paste", "add-modal-file-btn", "add-modal-file",
  "add-modal-adv", "add-modal-adv-hint", "add-modal-interval", "add-modal-interval-val",
  "add-modal-det", "add-modal-det-ico", "add-modal-det-kind", "add-modal-det-info", "add-modal-det-bar",
  "add-modal-submit", "add-modal-credentials", "add-modal-username", "add-modal-password",
].map(id => [id, new FakeElement()]));
const field = (name) => elements.get(`add-modal-${name}`);
const storage = new Map();
globalThis.localStorage = {
  getItem: key => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, String(value)),
  removeItem: key => storage.delete(key),
};
globalThis.window = {};
globalThis.document = {
  getElementById: id => elements.get(id) || null,
  addEventListener() {},
  removeEventListener() {},
};
const { mountAddModal, openAddModal } = await import("/lib/add-modal.js");
mountAddModal();

const ovpn = `client
dev tun
remote vpn.example.net 1194
auth-user-pass
<ca>
-----BEGIN CERTIFICATE-----
test-ca
-----END CERTIFICATE-----
</ca>`;
const vless = "vless://00000000-0000-4000-8000-000000000001@example.net:443?security=tls";

async function start() {
  await field("cancel").dispatch("click");
  storage.clear();
  openAddModal();
}
async function paste(value) {
  field("url").value = value;
  await field("url").dispatch("input");
}
function amneziaKey() {
  const text = Buffer.from(JSON.stringify({ containers: [{
    container: "amnezia-openvpn",
    openvpn: { last_config: JSON.stringify({ config: ovpn }) },
  }] }));
  const size = Buffer.alloc(4);
  size.writeUInt32BE(text.length);
  return `vpn://${Buffer.concat([size, deflateSync(text)]).toString("base64url")}`;
}
async function until(check) {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.ok(check(), "ожидаемое состояние окна не появилось");
}

test("поля логина и пароля нужны только .ovpn без встроенных учётных данных", async () => {
  await start();
  assert.equal(field("credentials").hidden, true);
  await paste(ovpn);
  assert.equal(field("credentials").hidden, false);
  assert.equal(field("det").dataset.kind, "ovpn-conf");
  field("username").value = "provider-user";
  field("password").value = "provider-password";
  await paste(vless);
  assert.equal(field("credentials").hidden, true);
  assert.equal(field("username").value, "");
  assert.equal(field("password").value, "");
  await paste(`${ovpn}\n<auth-user-pass>\ninline-user\ninline-password\n</auth-user-pass>`);
  assert.equal(field("credentials").hidden, true);
  await paste(Buffer.from(ovpn).toString("base64"));
  assert.equal(field("credentials").hidden, false);
  await field("cancel").dispatch("click");
  assert.equal(field("credentials").hidden, true);
});

test("перетаскивание .ovpn заполняет поле, имя файла и обязательные данные для входа", async () => {
  await start();
  const original = `\n# Provider VPN\n${ovpn}\n`;
  let prevented = false;
  const modal = elements.get("add-modal");
  await modal.dispatch("drop", {
    dataTransfer: { files: [{ name: "Provider.ovpn", text: async () => original }] },
    preventDefault() { prevented = true; },
  });
  assert.equal(prevented, true);
  assert.equal(field("url").value, original);
  assert.equal(field("name").value, "Provider");
  assert.equal(field("credentials").hidden, false);
  await field("submit").dispatch("click");
  assert.equal(storage.get("ninety.profiles.v1"), undefined);
  assert.equal(elements.get("add-modal").hidden, false);
  field("username").value = "provider-user";
  field("password").value = "provider-password";
  await field("submit").dispatch("click");
  const [profile] = JSON.parse(storage.get("ninety.profiles.v1"));
  assert.equal(profile.endpoint.username, "provider-user");
  assert.equal(profile.endpoint.password, "provider-password");
  assert.equal(profile.ovpn, original);
  assert.equal(elements.get("add-modal").hidden, true);
  assert.equal(field("password").value, "");
  const html = readFileSync(new URL("../src/index.html", import.meta.url), "utf8");
  assert.match(html, /id="add-modal-file"[^>]*accept="[^"]*\.ovpn/);
  const config = JSON.parse(readFileSync(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"));
  assert.equal(config.app.windows.find(win => win.label === "main").dragDropEnabled, false);
});

test("ключ Amnezia OpenVPN открывает поля учётных данных после распаковки", async () => {
  await start();
  await paste(amneziaKey());
  await until(() => !field("credentials").hidden);
  field("username").value = "amnezia-user";
  field("password").value = "amnezia-password";
  await field("submit").dispatch("click");
  const [profile] = JSON.parse(storage.get("ninety.profiles.v1"));
  assert.equal(profile.proto, "openvpn");
  assert.equal(profile.endpoint.username, "amnezia-user");
  assert.equal(profile.endpoint.password, "amnezia-password");
});

test("завершившаяся распаковка старого ключа не открывает поля у другого профиля", async () => {
  await start();
  const NativeDecompressionStream = globalThis.DecompressionStream;
  let release;
  let completed = false;
  const gate = new Promise(resolve => { release = resolve; });
  globalThis.DecompressionStream = class {
    constructor(format) {
      const stream = new NativeDecompressionStream(format);
      this.writable = stream.writable;
      this.readable = stream.readable.pipeThrough(new TransformStream({
        async transform(chunk, controller) {
          await gate;
          controller.enqueue(chunk);
        },
        flush() { completed = true; },
      }));
    }
  };
  try {
    await paste(amneziaKey());
    await paste(vless);
    release();
    await until(() => completed);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(field("credentials").hidden, true);
    assert.equal(field("det").dataset.kind, "config");
  } finally {
    release();
    globalThis.DecompressionStream = NativeDecompressionStream;
  }
});
