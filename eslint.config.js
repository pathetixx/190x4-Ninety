// Ninety · ESLint flat config. Гейт ловит РЕАЛЬНЫЕ баги (необъявленные globals,
// дубли ключей, недостижимый код, сравнение с NaN), не навязывая стиль — форматом
// правит рука (fmt намеренно выключен и в Rust-части). CI зовёт eslint с
// --max-warnings 0 (см. package.json), поэтому и warn-правила (unused-vars) валят
// сборку — baseline держим на нуле находок. Уровень warn оставлен, чтобы локальный
// `eslint` без флага отличал стилевую находку от настоящей ошибки в выводе.

import js from "@eslint/js";
import globals from "globals";

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
    rules: {
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
    // CI-only README wrappers физически лежат в scripts/, но исполняются внутри
    // Tauri WebView2. Даём им browser globals, сохраняя остальные Node-правила.
    files: ["scripts/readme-capture-*.js"],
    languageOptions: {
      globals: { ...globals.browser },
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
