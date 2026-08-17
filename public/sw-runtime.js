export function startServiceWorker(worker, version) {
  const shellPrefix = "kyle-shell-";
  const shell = [
    "/",
    "/manifest.webmanifest",
    "/house-by-30-icon-192.png",
    "/house-by-30-icon-512.png",
    "/house-by-30-icon-1024.png",
    "/house-by-30-icon-maskable-512.png",
    "/house-by-30-apple-touch-icon.png",
  ];
  worker.addEventListener("install", (event) => {
    event.waitUntil(
      worker.caches.open(version).then((cache) => cache.addAll(shell)),
    );
  });
  worker.addEventListener("activate", (event) => {
    event.waitUntil(
      worker.caches
        .keys()
        .then((keys) =>
          Promise.all(
            keys
              .filter((key) => key.startsWith(shellPrefix) && key !== version)
              .map((key) => worker.caches.delete(key)),
          ),
        )
        .then(() => worker.clients.claim()),
    );
  });
  worker.addEventListener("message", (event) => {
    if (event.data?.type === "SKIP_WAITING") {
      event.waitUntil(worker.skipWaiting());
      return;
    }
    if (event.data?.type !== "CACHE_URLS" || !Array.isArray(event.data.urls))
      return;
    const urls = event.data.urls.filter((url) => {
      if (typeof url !== "string") return false;
      const parsed = new URL(url, worker.location.origin);
      return (
        parsed.origin === worker.location.origin &&
        !parsed.pathname.startsWith("/api/")
      );
    });
    event.waitUntil(
      worker.caches.open(version).then((cache) => cache.addAll(urls)),
    );
  });
  worker.addEventListener("fetch", (event) => {
    const request = event.request;
    if (request.method !== "GET") return;
    const url = new URL(request.url);
    if (
      url.origin !== worker.location.origin ||
      url.pathname.startsWith("/api/")
    )
      return;
    if (request.mode === "navigate") {
      event.respondWith(
        worker
          .fetch(request)
          .then(async (response) => {
            if (response.ok) {
              const cache = await worker.caches.open(version);
              await cache.put("/", response.clone());
            }
            return response;
          })
          .catch(() => worker.caches.match("/")),
      );
      return;
    }
    if (
      url.pathname.startsWith("/_next/static/") ||
      shell.includes(url.pathname)
    ) {
      event.respondWith(
        worker.caches.match(request).then(
          (cached) =>
            cached ??
            worker.fetch(request).then(async (response) => {
              if (response.ok) {
                const cache = await worker.caches.open(version);
                await cache.put(request, response.clone());
              }
              return response;
            }),
        ),
      );
    }
  });
}
