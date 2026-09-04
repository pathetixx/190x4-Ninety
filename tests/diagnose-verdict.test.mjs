// Вердикт диагностики: приоритет правил и границы выводов.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  blockedDirectRows,
  blockedTunnelRows,
  buildVerdict,
  countFindings,
  verdictFacts,
} from "/lib/diagnose-verdict.js";

const row = (id, direct, tunnel) => ({
  id,
  direct: typeof direct === "string" ? { state: direct } : direct,
  tunnel: typeof tunnel === "string" ? { state: tunnel } : tunnel,
});

const trace = (over = {}) => ({
  resolvedIp: "185.0.0.1",
  port: 443,
  icmpReached: true,
  tcpOpen: false,
  tcp: { state: "silent", ms: 1200 },
  control: { state: "open", ms: 20 },
  hops: [
    { ttl: 1, rttMs: 1 },
    { ttl: 2, rttMs: 3 },
    { ttl: 3, rttMs: 40 },
  ],
  ...over,
});

test("вердикт: фильтр в пути важнее всего остального", () => {
  const verdict = buildVerdict({
    trace: trace(),
    reach: [row("a", "timeout", "ok"), row("b", "timeout", "ok")],
    leaks: { ipv6Open: { state: "warn" } },
  });
  assert.equal(verdict.kind, "filterInPath");
  assert.equal(verdict.severity, "err");
  assert.equal(verdict.action, "dpi");
  assert.equal(verdict.params.ip, "185.0.0.1");
});

test("вердикт: явный отказ порта — это сервер, а не фильтр", () => {
  const verdict = buildVerdict({ trace: trace({ tcp: { state: "refused", ms: 30 } }) });
  assert.equal(verdict.kind, "serverPortSilent");
  assert.equal(verdict.action, "switchNode");
});

test("вердикт: путь до сервера не доходит вовсе", () => {
  const verdict = buildVerdict({ trace: trace({ icmpReached: false }) });
  assert.equal(verdict.kind, "serverUnreachable");
});

test("вердикт: мёртвый контрольный адрес переводит стрелки на сеть", () => {
  // Контрольная проба нужна ровно для этого: без неё «не пускает к серверу» и
  // «в сети вообще нет TCP» неразличимы, и вердикт врал бы про сервер.
  const verdict = buildVerdict({ trace: trace({ control: { state: "silent", ms: 1200 } }) });
  assert.equal(verdict.kind, "localNetwork");
  assert.equal(verdict.action, null);
});

test("вердикт: открытый порт не создаёт вердикта по трассе", () => {
  const clean = [row("a", "ok", "ok")];
  const verdict = buildVerdict({
    trace: trace({ tcpOpen: true, tcp: { state: "open", ms: 44 } }),
    reach: clean,
    connected: true,
  });
  assert.equal(verdict.kind, "clean");
});

test("вердикт: сеть блокирует часть интернета, туннель её открывает", () => {
  const verdict = buildVerdict({
    reach: [row("a", "timeout", "ok"), row("b", "timeout", "ok"), row("c", "ok", "ok")],
    connected: true,
  });
  assert.equal(verdict.kind, "networkBlocks");
  assert.equal(verdict.severity, "warn");
  assert.equal(verdict.params.count, 2);
});

test("вердикт: одна упавшая цель из десяти — это не блокировка сети", () => {
  const rows = [row("a", "timeout", "ok")];
  for (let i = 0; i < 9; i++) rows.push(row(`ok${i}`, "ok", "ok"));
  const verdict = buildVerdict({ reach: rows, connected: true });
  assert.equal(verdict.kind, "clean");
});

test("вердикт: туннель мешает локальному сервису → предлагаем правило", () => {
  const rows = [row("bank", "ok", "timeout")];
  for (let i = 0; i < 5; i++) rows.push(row(`ok${i}`, "ok", "ok"));
  const verdict = buildVerdict({ reach: rows, connected: true });
  assert.equal(verdict.kind, "tunnelBlocksLocal");
  assert.equal(verdict.action, "ruleDirect");
});

test("вердикт: сервис отказывает адресу сервера → предлагаем смену ноды", () => {
  const rows = [row("chatgpt", { state: "ok" }, { state: "http", httpStatus: 403 })];
  for (let i = 0; i < 5; i++) rows.push(row(`ok${i}`, "ok", "ok"));
  const verdict = buildVerdict({ reach: rows, connected: true });
  // Строка с 403 попадает и в «мешает туннель», и в «отказал сервис»; первым
  // правилом идёт то, что человек может починить правилом маршрутизации.
  assert.ok(["tunnelBlocksLocal", "serviceRefusesNode"].includes(verdict.kind));
  assert.ok(["ruleDirect", "switchNode"].includes(verdict.action));
});

test("вердикт: про утечки говорим только когда со связью порядок", () => {
  const clean = [row("a", "ok", "ok"), row("b", "ok", "ok")];
  assert.equal(buildVerdict({ reach: clean, leaks: { ipv6Open: { state: "warn" } } }).kind, "ipv6Open");
  assert.equal(
    buildVerdict({ reach: clean, leaks: { dnsInTunnel: { state: "err" } } }).kind,
    "dnsBroken",
  );
});

test("вердикт: пустой прогон — это приглашение, а не «всё хорошо»", () => {
  assert.equal(buildVerdict({}).kind, "idle");
  assert.equal(buildVerdict({}).action, "run");
});

test("вердикт: чистая сеть различает подключённый и отключённый туннель", () => {
  const clean = [row("a", "ok", "ok")];
  assert.equal(buildVerdict({ reach: clean, connected: true }).kind, "clean");
  assert.equal(buildVerdict({ reach: clean, connected: false }).kind, "cleanOffline");
});

test("строки-хелперы делят матрицу по виновнику", () => {
  const rows = [row("a", "timeout", "ok"), row("b", "ok", "timeout"), row("c", "ok", "ok")];
  assert.deepEqual(blockedDirectRows(rows).map((r) => r.id), ["a"]);
  assert.deepEqual(blockedTunnelRows(rows).map((r) => r.id), ["b"]);
});

test("факты вердикта собираются из того, что реально померили", () => {
  const facts = verdictFacts({
    trace: trace({ tcpOpen: true, tcp: { state: "open", ms: 44 } }),
    leaks: { dnsInTunnel: { state: "ok" }, ipv6Open: { state: "ok" }, externalIp: { state: "ok", detail: "1.2.3.4" } },
    reach: [row("a", "ok", "ok"), row("b", "ok", "timeout")],
  });
  const byKey = Object.fromEntries(facts.map((f) => [f.key, f]));
  assert.equal(byKey.trace.state, "ok");
  assert.equal(byKey.trace.value, "44");
  assert.equal(byKey.ip.value, "1.2.3.4");
  assert.equal(byKey.reach.value, "1/2");
  assert.equal(verdictFacts({}).length, 0);
});

test("счётчик находок: строка с 403 считается один раз, а не дважды", () => {
  const rows = [
    row("chatgpt", { state: "ok" }, { state: "http", httpStatus: 403 }),
    row("bank", "ok", "timeout"),
    row("discord", "timeout", "ok"),
    row("fine", "ok", "ok"),
  ];
  // 403 + банк + спасённый Discord = 3, дубля быть не должно.
  assert.equal(countFindings({ reach: rows }), 3);
});

test("счётчик находок: трасса и утечки добавляют свои", () => {
  const base = { reach: [row("fine", "ok", "ok")] };
  assert.equal(countFindings(base), 0);
  assert.equal(countFindings({ ...base, trace: trace() }), 1);
  assert.equal(countFindings({ ...base, trace: trace({ tcpOpen: true }) }), 0);
  assert.equal(
    countFindings({ ...base, leaks: { ipv6Open: { state: "warn" }, dnsInTunnel: { state: "ok" } } }),
    1,
  );
});

test("счётчик находок: пустой прогон не находка", () => {
  assert.equal(countFindings({}), 0);
});
