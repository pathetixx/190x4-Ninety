// Ninety · ESLint flat config. Гейт ловит РЕАЛЬНЫЕ баги (необъявленные globals,
// дубли ключей, недостижимый код, сравнение с NaN), не навязывая стиль — форматом
// правит рука (fmt намеренно выключен и в Rust-части). CI зовёт eslint с
// --max-warnings 0 (см. package.json), поэтому и warn-правила (unused-vars) валят
// сборку — baseline держим на нуле находок. Уровень warn оставлен, чтобы локальный
// `eslint` без флага отличал стилевую находку от настоящей ошибки в выводе.

import js from "@eslint/js";
import globals from "globals";

// Затенение импорта локальным именем — баг этого кода, а не стиль: в dpi-view
// `const t = e.target` перекрывал импортированную `t` из i18n, и клик по
// тумблеру падал с TypeError уже ПОСЛЕ записи настройки и перезапуска движка.
// Готовое `no-shadow` для этого слишком шумно (46 находок, почти все — про
// hoist локальных имён), поэтому гейтим ровно этот класс.
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
    // Сторонний код и не-исходники не линтуем.
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
    // Фронтенд — браузерные ES-модули (withGlobalTauri: __TAURI__ берётся как
    // window.__TAURI__, отдельный global не нужен).
    files: ["src/**/*.js", "site/**/*.js"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: { ...globals.browser },
    },
    plugins: { ninety: ninetyPlugin },
    rules: {
      "ninety/no-import-shadow": "error",
      // catch {} без тела — осознанный паттерн (best-effort операции по всему коду).
      "no-empty": ["error", { allowEmptyCatch: true }],
      // while(true) reconnect-циклы и т.п. — не константный баг.
      "no-constant-condition": ["error", { checkLoops: false }],
      // Мёртвые переменные — сигнал, но не повод валить CI: показываем как warn.
      // Аргументы и пойманные ошибки не караем (обработчики, сигнатуры API).
      "no-unused-vars": ["warn", { args: "none", caughtErrors: "none" }],
    },
  },
  {
    // Тесты и скрипты сборки — Node-окружение.
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
