// Регистрация loader'а для node --test (современный API вместо deprecated --loader).
// Запуск: node --test --import ./tests/register.mjs tests/
import { register } from "node:module";

register("./loader.mjs", import.meta.url);
