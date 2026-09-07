import { test } from "node:test";
import assert from "node:assert/strict";

// Поповер «Режим подключения» позиционируется скриптом, а не CSS. Раскладка
// зеркалится в fa/ar (dir="rtl"), и тулбар с кнопкой уезжает к левому краю —
// проверяем, что карточка при этом остаётся внутри окна.
const POPOVER_WIDTH = 320;
const WINDOW_WIDTH = 1180;

function makeEl(extra = {}) {
  const listeners = new Map();
  return {
    hidden: true,
    style: {},
    attrs: {},
    offsetWidth: 0,
    rect: { top: 0, bottom: 0, left: 0, right: 0 },
    getBoundingClientRect() { return this.rect; },
    setAttribute(name, value) { this.attrs[name] = value; },
    addEventListener(type, fn) { listeners.set(type, fn); },
    fire(type, event = {}) { listeners.get(type)?.({ stopPropagation() {}, ...event }); },
    ...extra,
  };
}

// Кнопка тулбара в LTR стоит у правого края окна, в RTL — зеркально у левого.
function setup({ dir, btnLeft }) {
  const btn = makeEl();
  btn.rect = { top: 24, bottom: 64, left: btnLeft, right: btnLeft + 40 };
  const el = makeEl({ offsetWidth: POPOVER_WIDTH });

  globalThis.document = {
    documentElement: {},
    getElementById: (id) => (id === "mode-toggle" ? btn : id === "mode-popover" ? el : null),
    addEventListener() {},
  };
  globalThis.window = { innerWidth: WINDOW_WIDTH, addEventListener() {} };
  globalThis.getComputedStyle = () => ({ direction: dir });

  return { btn, el };
}

async function openPopover(opts) {
  const { initPopovers } = await import("/lib/popovers.js");
  const { btn, el } = setup(opts);
  initPopovers();
  btn.fire("click");
  return { btn, el };
}

test("LTR: правый край поповера совпадает с правым краем кнопки", async () => {
  const { el } = await openPopover({ dir: "ltr", btnLeft: 1080 });
  assert.equal(el.hidden, false);
  assert.equal(el.style.left, `${1120 - POPOVER_WIDTH}px`);
  assert.equal(el.style.right, "auto");
  assert.equal(el.style.top, "72px");
});

test("RTL: поповер раскрывается от левого края кнопки и остаётся в окне", async () => {
  const { el } = await openPopover({ dir: "rtl", btnLeft: 60 });
  assert.equal(el.style.left, "60px");
  assert.ok(parseInt(el.style.left, 10) + POPOVER_WIDTH <= WINDOW_WIDTH);
});

test("кнопка у самого края окна: поповер не вылезает за границы", async () => {
  const rtl = await openPopover({ dir: "rtl", btnLeft: 1160 });
  assert.equal(rtl.el.style.left, `${WINDOW_WIDTH - POPOVER_WIDTH - 8}px`);

  const ltr = await openPopover({ dir: "ltr", btnLeft: 4 });
  assert.equal(ltr.el.style.left, "8px");
});

test("после позиционирования поповер остаётся видимым, а не спрятанным замером", async () => {
  const { el, btn } = await openPopover({ dir: "rtl", btnLeft: 60 });
  assert.equal(el.hidden, false);
  assert.equal(el.style.visibility, "");
  assert.equal(btn.attrs["aria-expanded"], "true");
});
