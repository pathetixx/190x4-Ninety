// Registering the loader for node --test (the modern API instead of the deprecated --loader).
// Run: node --test --import ./tests/register.mjs tests/
import { register } from "node:module";

register("./loader.mjs", import.meta.url);
