// Mapping browser absolute imports ("/lib/...") to repo files.
// The frontend lives without a bundler (frontendDist=../src), modules reference each other
// by absolute paths from the WebView root — node can't resolve that.
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url))); // the repo root

// Roots that actually exist under src/ and are referenced by the frontend.
// Absolute OS paths (e.g. /root/…) don't get here — otherwise a test that
// imports a file by its full path would break.
const WEBVIEW_ROOTS = ["/lib/", "/vendor/", "/assets/"];

export function resolve(specifier, context, nextResolve) {
  if (WEBVIEW_ROOTS.some((root) => specifier.startsWith(root))) {
    return nextResolve(pathToFileURL(path.join(ROOT, "src", specifier)).href, context);
  }
  return nextResolve(specifier, context);
}
