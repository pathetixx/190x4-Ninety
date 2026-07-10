import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const workflowsDir = ".github/workflows";
const workflowFiles = (await readdir(workflowsDir))
  .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
  .sort();
const violations = [];

for (const file of workflowFiles) {
  const text = await readFile(join(workflowsDir, file), "utf8");
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    const match = line.match(/^\s*(?:-\s*)?uses:\s*([^\s#]+)/);
    if (!match || match[1].startsWith("./")) continue;
    const [, reference] = match;
    if (!/^[^@\s]+@[0-9a-f]{40}$/i.test(reference)) {
      violations.push(`${file}:${index + 1}: external action must use a 40-character commit SHA (${reference})`);
    }
  }
}

if (violations.length) {
  console.error(violations.join("\n"));
  process.exit(1);
}

console.log(`Action pinning OK: ${workflowFiles.length} workflow files checked`);
