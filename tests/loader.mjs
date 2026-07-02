// Маппинг браузерных абсолютных импортов ("/lib/...") на файлы репо.
// Фронт живёт без бандлера (frontendDist=../src), модули ссылаются друг на друга
// абсолютными путями от корня WebView — node так резолвить не умеет.
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url))); // корень репо

export function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("/lib/")) {
    return nextResolve(pathToFileURL(path.join(ROOT, "src", specifier)).href, context);
  }
  return nextResolve(specifier, context);
}
