// Маппинг браузерных абсолютных импортов ("/lib/...") на файлы репо.
// Фронт живёт без бандлера (frontendDist=../src), модули ссылаются друг на друга
// абсолютными путями от корня WebView — node так резолвить не умеет.
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url))); // корень репо

// Корни, которые реально существуют под src/ и на которые ссылается фронт.
// Абсолютные пути ОС (например /root/…) сюда не попадают — иначе тест, который
// импортирует файл по полному пути, сломался бы.
const WEBVIEW_ROOTS = ["/lib/", "/vendor/", "/assets/"];

export function resolve(specifier, context, nextResolve) {
  if (WEBVIEW_ROOTS.some((root) => specifier.startsWith(root))) {
    return nextResolve(pathToFileURL(path.join(ROOT, "src", specifier)).href, context);
  }
  return nextResolve(specifier, context);
}
