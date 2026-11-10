// Baritone service worker: offline app shell + cross-origin isolation headers
// (lets the speech engine use multiple CPU threads). MIT License.
const VERSION = "baritone-v2";
const SHELL = [
  "./", "index.html", "app.js", "textproc.js", "tts-worker.js", "manifest.webmanifest",
  "vendor/kokoro.web.js", "vendor/pdfjs/pdf.min.mjs", "vendor/pdfjs/pdf.worker.min.mjs",
  "vendor/ort/ort-wasm-simd-threaded.jsep.mjs", "vendor/ort/ort-wasm-simd-threaded.jsep.wasm",
  "icons/icon-180.png", "icons/icon-192.png", "icons/icon-512.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith("baritone-") && k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function isolate(res) {
  if (!res || res.status === 0 || res.type === "opaque") return res;
  const h = new Headers(res.headers);
  h.set("Cross-Origin-Opener-Policy", "same-origin");
  h.set("Cross-Origin-Embedder-Policy", "require-corp");
  h.set("Cross-Origin-Resource-Policy", "same-origin");
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin || e.request.method !== "GET") return; // model files: browser cache handles them
  e.respondWith((async () => {
    const cache = await caches.open(VERSION);
    const hit = await cache.match(e.request, { ignoreSearch: true });
    if (hit) {
      // refresh in the background so updates arrive on next launch
      e.waitUntil(fetch(e.request).then((r) => r.ok && cache.put(e.request, r.clone())).catch(() => {}));
      return isolate(hit);
    }
    try {
      const r = await fetch(e.request);
      if (r.ok) cache.put(e.request, r.clone());
      return isolate(r);
    } catch {
      return isolate(await cache.match("index.html"));
    }
  })());
});
