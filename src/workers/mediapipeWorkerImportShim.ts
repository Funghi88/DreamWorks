/**
 * @mediapipe/tasks-vision loads `vision_wasm_internal.js` via `importScripts` or `await self.import(url)`.
 * Dynamic `import()` executes it as an ES module → `var ModuleFactory` never becomes `globalThis.ModuleFactory`
 * → `Error: ModuleFactory not set` → worker init fails → main-thread fallback → UI jank / menu icons flicker.
 *
 * Must intercept **both** `importScripts` (when present) **and** `self.import` for `*vision_wasm*internal*.js`
 * and run the loader as a classic script (sync XHR + indirect eval) so `ModuleFactory` exists on `globalThis`.
 */

const g = globalThis as typeof globalThis & {
  import?: (specifier: string | URL) => Promise<unknown>;
  importScripts?: (...urls: (string | URL)[]) => void;
};

const isVisionWasmLoaderUrl = (url: string): boolean =>
  url.includes("vision_wasm") && url.includes("internal") && url.endsWith(".js");

/**
 * Runs the published MediaPipe loader script so `var ModuleFactory` binds to the global object.
 */
function installVisionWasmLoader(url: string): void {
  const xhr = new XMLHttpRequest();
  xhr.open("GET", url, false);
  xhr.send();
  if (xhr.status !== 200 && xhr.status !== 0) {
    throw new Error(`[mediapipeWorkerImportShim] load failed ${xhr.status}: ${url}`);
  }
  const code = xhr.responseText;
  (0, eval)(code);
  const gt = globalThis as unknown as { ModuleFactory?: unknown };
  if (typeof gt.ModuleFactory === "function") return;

  /** Last resort: bridge if indirect eval left a sloppy `ModuleFactory` binding not mirrored on globalThis. */
  try {
    const ctor = (0, eval)(
      `(function(){ try { return typeof ModuleFactory !== "undefined" ? ModuleFactory : null; } catch { return null; } })()`
    ) as unknown;
    if (typeof ctor === "function") {
      gt.ModuleFactory = ctor;
    }
  } catch {
    /* ignore */
  }
  if (typeof gt.ModuleFactory !== "function") {
    throw new Error("[mediapipeWorkerImportShim] vision_wasm_internal.js did not define ModuleFactory on globalThis");
  }
}

const dynamicImport = (specifier: string | URL) =>
  import(typeof specifier === "string" ? specifier : specifier.toString());

g.import = async (specifier: string | URL) => {
  const url =
    typeof specifier === "string"
      ? specifier
      : specifier instanceof URL
        ? specifier.href
        : String(specifier);
  if (isVisionWasmLoaderUrl(url)) {
    installVisionWasmLoader(url);
    return {};
  }
  return dynamicImport(specifier);
};

{
  const prevImportScripts = g.importScripts;
  const poly = (...urls: (string | URL)[]): void => {
    const u = String(urls[0]);
    if (isVisionWasmLoaderUrl(u)) {
      installVisionWasmLoader(u);
      return;
    }
    if (typeof prevImportScripts === "function") {
      prevImportScripts.call(g, ...urls);
      return;
    }
    throw new TypeError(
      "[mediapipeWorkerImportShim] importScripts unavailable for non-vision URL; use import()"
    );
  };
  (g as unknown as { importScripts: typeof poly }).importScripts = poly;
}
