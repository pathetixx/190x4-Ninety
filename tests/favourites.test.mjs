// Favorites are stored per source. A source without its own key (the subscription
// isn't saved yet, WARP-only) has nothing to remember with: the former "none" bucket was erased by
// dropLegacyBuckets in the same write, and the star went out on the next render.
import { test } from "node:test";
import assert from "node:assert/strict";

function makeStorage() {
  const data = new Map();
  return {
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => data.set(k, String(v)),
    removeItem: (k) => data.delete(k),
    clear: () => data.clear(),
  };
}
globalThis.localStorage = makeStorage();
globalThis.window = globalThis.window || {};

const { getFavourites, isFavourite, toggleFavourite } = await import("/lib/favourites.js");

const subscription = { kind: "sub", subscription: { id: "s1" } };
const keyless = { kind: "sub", subscription: {} };

test("избранное подписки переживает запись и чтение", () => {
  assert.equal(toggleFavourite(subscription, "node-a"), true);
  assert.equal(isFavourite(subscription, "node-a"), true);
  assert.deepEqual([...getFavourites(subscription)], ["node-a"]);

  assert.equal(toggleFavourite(subscription, "node-a"), false);
  assert.equal(isFavourite(subscription, "node-a"), false);
});

test("источник без ключа не заводит ведро, которое всё равно будет стёрто", () => {
  assert.equal(toggleFavourite(keyless, "node-a"), false);
  assert.equal(getFavourites(keyless).size, 0);
  assert.equal(getFavourites(null).size, 0);
  // Other favorites weren't affected.
  toggleFavourite(subscription, "node-b");
  assert.deepEqual([...getFavourites(subscription)], ["node-b"]);
  assert.equal(localStorage.getItem("ninety.favourites").includes("none"), false);
});
