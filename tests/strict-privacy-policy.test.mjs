import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_OPTIONS } from "/lib/options.js";
import {
  STRICT_PRIVACY_POLICY_ID,
  applyStrictPrivacyOptions,
  createStrictPrivacyPolicy,
  prepareStrictPrivacyRuntime,
  resolveRuntimePrivacyPolicy,
  selectStrictPrivacyCandidate,
} from "/lib/strict-privacy-policy.js";

test("строгая политика создаёт отдельную безопасную runtime-копию options", () => {
  const input = structuredClone(DEFAULT_OPTIONS);
  input.region = "ru";
  input.general.disableGeoLookup = false;
  input.general.allowDirectSubscriptionFallback = true;
  input.warp.enabled = true;
  input.warp.autoRescan = true;
  input.dns.remoteAddress = "https://dns.example/dns-query";
  input.dns.enableFakeDns = true;
  input.route.bypassLan = true;
  input.route.resolveDestination = false;
  input.route.ipv6Mode = "only";
  input.route.tunSplitDiscord = true;
  input.route.customRules = [
    { id: "direct", enabled: true, action: "direct" },
    { id: "proxy", enabled: true, action: "proxy" },
    { id: "block", enabled: true, action: "block" },
  ];
  input.inbound.strictRoute = false;
  input.inbound.allowConnectionFromLan = true;
  input.quality.enabled = true;
  const before = structuredClone(input);

  const out = applyStrictPrivacyOptions(input);

  assert.deepEqual(input, before, "сохранённые настройки не должны мутировать");
  assert.notEqual(out, input);
  assert.equal(out.region, "other");
  assert.equal(out.general.disableGeoLookup, true);
  assert.equal(out.general.allowDirectSubscriptionFallback, false);
  assert.equal(out.warp.enabled, false);
  assert.equal(out.warp.autoRescan, false);
  assert.equal(out.dns.remoteAddress, DEFAULT_OPTIONS.dns.remoteAddress);
  assert.equal(out.dns.enableFakeDns, false);
  assert.equal(out.route.bypassLan, false);
  assert.equal(out.route.resolveDestination, true);
  assert.equal(out.route.ipv6Mode, "disable");
  assert.equal(out.route.tunSplitDiscord, false);
  assert.deepEqual(out.route.customRules.map((rule) => rule.id), ["proxy", "block"]);
  assert.equal(out.inbound.strictRoute, true);
  assert.equal(out.inbound.allowConnectionFromLan, false);
  assert.equal(out.quality.enabled, false);
});

test("prepareStrictPrivacyRuntime принудительно выбирает TUN и отдаёт явную политику", () => {
  const prepared = prepareStrictPrivacyRuntime({
    options: DEFAULT_OPTIONS,
    selectedNodeTag: " node-fixed ",
  });
  assert.equal(prepared.mode, "tun");
  assert.equal(prepared.options.inbound.strictRoute, true);
  assert.equal(prepared.runtimePolicy.id, STRICT_PRIVACY_POLICY_ID);
  assert.equal(prepared.runtimePolicy.selectedNodeTag, "node-fixed");
  assert.equal(Object.isFrozen(prepared.runtimePolicy), true);

  const resolved = resolveRuntimePrivacyPolicy({
    mode: "proxy",
    options: DEFAULT_OPTIONS,
    runtimePolicy: createStrictPrivacyPolicy({ selectedNodeTag: "node-fixed" }),
  });
  assert.equal(resolved.mode, "tun");
  assert.equal(resolved.strictPrivacy, true);
  assert.equal(resolved.selectedNodeTag, "node-fixed");

  const withDefaults = prepareStrictPrivacyRuntime();
  assert.equal(withDefaults.options.dns.remoteAddress, DEFAULT_OPTIONS.dns.remoteAddress);
  assert.equal(withDefaults.options.inbound.strictRoute, true);
});

test("строгий выбор fail-closed: multi-node требует существующий конкретный тег", () => {
  const candidates = [
    { tag: "node-a", value: { name: "A" } },
    { tag: "node-b", value: { name: "B" } },
  ];
  assert.equal(selectStrictPrivacyCandidate(candidates, "node-b").value.name, "B");
  assert.throws(
    () => selectStrictPrivacyCandidate(candidates, null),
    (error) => error?.code === "STRICT_PRIVACY_NODE_REQUIRED",
  );
  assert.throws(
    () => selectStrictPrivacyCandidate(candidates, "auto"),
    (error) => error?.code === "STRICT_PRIVACY_NODE_REQUIRED",
  );
  assert.throws(
    () => selectStrictPrivacyCandidate(candidates, "node-gone"),
    (error) => error?.code === "STRICT_PRIVACY_NODE_UNAVAILABLE",
  );
  assert.equal(selectStrictPrivacyCandidate([candidates[0]], null), candidates[0]);
  assert.equal(selectStrictPrivacyCandidate([candidates[0]], "node-a"), candidates[0]);
  assert.throws(
    () => selectStrictPrivacyCandidate([candidates[0]], "node-b"),
    (error) => error?.code === "STRICT_PRIVACY_NODE_UNAVAILABLE",
  );
});
