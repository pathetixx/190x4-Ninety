// Пересылка IP (#168): признак проблемы и команда исправления.
import { test } from "node:test";
import assert from "node:assert/strict";
import { forwardingAliases, forwardingFixCommand, forwardingProblem } from "/lib/forwarding.js";

test("проблема — только пересылка на интерфейсе, а не флаг реестра", () => {
  assert.equal(forwardingProblem(null), false);
  assert.equal(forwardingProblem({ routerEnabled: true, interfaces: [] }), false);
  assert.equal(forwardingProblem({ routerEnabled: false, interfaces: [{ alias: "Ethernet", family: "ipv4" }] }), true);
});

test("команда выключает каждое семейство и флаг реестра", () => {
  const command = forwardingFixCommand({
    routerEnabled: true,
    interfaces: [{ alias: "Ethernet", family: "ipv4" }, { alias: "Ethernet", family: "ipv6" }],
  });
  assert.deepEqual(command.split("\n"), [
    "Set-NetIPInterface -InterfaceAlias 'Ethernet' -AddressFamily IPv4 -Forwarding Disabled",
    "Set-NetIPInterface -InterfaceAlias 'Ethernet' -AddressFamily IPv6 -Forwarding Disabled",
    "Set-ItemProperty 'HKLM:\\SYSTEM\\CurrentControlSet\\Services\\Tcpip\\Parameters' -Name IPEnableRouter -Value 0",
  ]);
});

test("кавычка в имени адаптера не ломает команду", () => {
  const command = forwardingFixCommand({ interfaces: [{ alias: "Dima's LAN", family: "ipv4" }] });
  assert.equal(command, "Set-NetIPInterface -InterfaceAlias 'Dima''s LAN' -AddressFamily IPv4 -Forwarding Disabled");
});

test("имена адаптеров без повторов", () => {
  assert.equal(forwardingAliases({
    interfaces: [{ alias: "Ethernet", family: "ipv4" }, { alias: "Ethernet", family: "ipv6" }, { alias: "Wi-Fi", family: "ipv4" }],
  }), "Ethernet, Wi-Fi");
});
