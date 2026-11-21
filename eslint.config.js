// Ninety · ESLint flat config. The gate catches REAL bugs (undeclared globals,
// duplicate keys, unreachable code, comparison with NaN) without imposing a style — formatting
// is done by hand (fmt is deliberately off in the Rust part too). CI calls eslint with
// --max-warnings 0 (see package.json), so warn rules (unused-vars) also fail
// the build — we keep the baseline at zero findings. The warn level is kept so that a local
// `eslint` without the flag distinguishes a style finding from a real error in the output.

import js from "@eslint/js";
import globals from "globals";

// Shadowing an import with a local name is a bug in this code, not style: in dpi-view
// `const t = e.target` shadowed the imported `t` from i18n, and a click on
// a toggle failed with a TypeError AFTER the setting was written and the engine restarted.
// The stock `no-shadow` is too noisy for this (46 findings, almost all about
// hoisting local names), so we gate exactly this class.
const ninetyPlugin = {
  rules: {
    "no-import-shadow": {
      meta: {
        type: "problem",
        docs: { description: "локальное имя не должно перекрывать импорт модуля" },
        schema: [],
        messages: {
          shadowed: "'{{name}}' перекрывает импорт: обращение по этому имени в данной области уйдёт не к импорту",
        },
      },
      create(context) {
        const imported = new Set();
        return {
          ImportDeclaration(node) {
            for (const specifier of node.specifiers) imported.add(specifier.local.name);
          },
          "Program:exit"(node) {
            if (imported.size === 0) return;
            const scopeManager = context.sourceCode.scopeManager;
            const walk = (scope) => {
              if (scope.type !== "module" && scope.type !== "global") {
                for (const variable of scope.variables) {
                  if (!imported.has(variable.name)) continue;
                  context.report({
                    node: variable.identifiers[0] || node,
                    messageId: "shadowed",
                    data: { name: variable.name },
                  });
                }
              }
              scope.childScopes.forEach(walk);
            };
            walk(scopeManager.acquire(node) || scopeManager.globalScope);
          },
        };
      },
    },
  },
};

export default [
  {
    // Third-party code and non-sources aren't linted.
    ignores: [
      "src/vendor/**",
      "src/assets/**",
      "src-tauri/**",
      "node_modules/**",
      "eslint.config.js",
    ],
  },
  js.configs.recommended,
  {
    // The frontend is browser ES modules (withGlobalTauri: __TAURI__ is taken as
    // window.__TAURI__, a separate global isn't needed).
    files: ["src/**/*.js", "site/**/*.js"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: { ...globals.browser },
    },
    plugins: { ninety: ninetyPlugin },
    rules: {
      "ninety/no-import-shadow": "error",
      // catch {} without a body is a deliberate pattern (best-effort operations throughout the code).
      "no-empty": ["error", { allowEmptyCatch: true }],
      // while(true) reconnect loops and the like aren't a constant-condition bug.
      "no-constant-condition": ["error", { checkLoops: false }],
      // Dead variables are a signal, but not a reason to fail CI: shown as warn.
      // Arguments and caught errors aren't penalized (handlers, API signatures).
      "no-unused-vars": ["warn", { args: "none", caughtErrors: "none" }],
    },
  },
  {
    // Tests and build scripts are a Node environment.
    files: ["tests/**/*.mjs", "scripts/**/*.{js,mjs}"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: { ...globals.node },
    },
    rules: {
      "no-empty": ["error", { allowEmptyCatch: true }],
      "no-unused-vars": ["warn", { args: "none", caughtErrors: "none" }],
    },
  },
];
