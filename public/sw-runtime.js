const BUILD_HEADER = "X-House-By-30-Build";
const SHELL_PREFIX = "kyle-shell-";
const PUBLIC_SHELL = [
  "/",
  "/manifest.webmanifest",
  "/house-by-30-icon-192.png",
  "/house-by-30-icon-512.png",
  "/house-by-30-icon-1024.png",
  "/house-by-30-icon-maskable-512.png",
  "/house-by-30-apple-touch-icon.png",
];
export function staticAssetUrls(html, origin) {
  const urls = new Set();
  for (const match of html.matchAll(/["'](\/_next\/static\/[^"'\s<>]+)["']/g)) {
    const value = match[1].replaceAll("&amp;", "&");
    const parsed = new URL(value, origin);
    if (
      parsed.origin === origin &&
      parsed.pathname.startsWith("/_next/static/")
    )
      urls.add(`${parsed.pathname}${parsed.search}`);
  }
  return [...urls];
}
export function isPublicCacheUrl(value, origin) {
  const parsed = new URL(value, origin);
  if (parsed.origin !== origin || parsed.searchParams.has("_rsc")) return false;
  if (parsed.pathname.startsWith("/_next/static/")) return true;
  return parsed.search === "" && PUBLIC_SHELL.includes(parsed.pathname);
}
function responseMatchesBuild(response, buildId) {
  const responseBuild = response.headers?.get(BUILD_HEADER);
  return responseBuild === buildId;
}
function isPrivateRequest(request, origin) {
  const url = new URL(request.url);
  return (
    url.origin !== origin ||
    url.pathname === "/api" ||
    url.pathname.startsWith("/api/") ||
    url.searchParams.has("_rsc") ||
    request.headers?.get("RSC") === "1"
  );
}
export function startServiceWorker(worker, buildId) {
  const version = `${SHELL_PREFIX}${buildId}`;
  const clientBuilds = new Map();
  const liveClients = () =>
    worker.clients.matchAll({ includeUncontrolled: true, type: "window" });
  const matchRetainedShell = async (request) => {
    const keys = await worker.caches.keys();
    const retained = keys
      .filter((key) => key.startsWith(SHELL_PREFIX) && key !== version)
      .reverse();
    for (const key of retained) {
      const response = await (await worker.caches.open(key)).match(request);
      if (response) return response;
    }
    return undefined;
  };
  const deleteUnusedShells = async () => {
    const clients = await liveClients();
    if (
      clients.length > 0 &&
      !clients.every((client) => clientBuilds.get(client.id) === buildId)
    )
      return;
    const keys = await worker.caches.keys();
    await Promise.all(
      keys
        .filter((key) => key.startsWith(SHELL_PREFIX) && key !== version)
        .map((key) => worker.caches.delete(key)),
    );
  };
  const requestClientBuilds = async () => {
    const clients = await liveClients();
    for (const client of clients)
      client.postMessage({ type: "REPORT_CLIENT_BUILD", buildId });
    if (clients.length === 0) await deleteUnusedShells();
  };
  worker.addEventListener("install", (event) => {
    event.waitUntil(
      (async () => {
        const cache = await worker.caches.open(version);
        const root = await worker.fetch("/", { cache: "no-store" });
        if (!root.ok || !responseMatchesBuild(root, buildId))
          throw new Error("The app shell does not match this service worker.");
        const html = root.text ? await root.clone().text() : "";
        await cache.put("/", root.clone());
        await cache.addAll([
          ...PUBLIC_SHELL.filter((url) => url !== "/"),
          ...staticAssetUrls(html, worker.location.origin),
        ]);
      })(),
    );
  });
  worker.addEventListener("activate", (event) => {
    event.waitUntil(
      (async () => {
        await worker.registration?.navigationPreload?.enable();
        await worker.clients.claim();
        await requestClientBuilds();
      })(),
    );
  });
  worker.addEventListener("message", (event) => {
    if (event.data?.type === "SKIP_WAITING") {
      event.waitUntil(worker.skipWaiting());
      return;
    }
    if (
      (event.data?.type === "CLIENT_READY" ||
        event.data?.type === "CLIENT_BUILD") &&
      event.source?.id &&
      typeof event.data.buildId === "string"
    ) {
      clientBuilds.set(event.source.id, event.data.buildId);
      event.waitUntil(
        event.data.type === "CLIENT_READY"
          ? requestClientBuilds().then(deleteUnusedShells)
          : deleteUnusedShells(),
      );
      return;
    }
    if (event.data?.type !== "CACHE_URLS" || !Array.isArray(event.data.urls))
      return;
    const urls = event.data.urls.filter(
      (url) =>
        typeof url === "string" &&
        isPublicCacheUrl(url, worker.location.origin),
    );
    event.waitUntil(
      worker.caches.open(version).then((cache) => cache.addAll(urls)),
    );
  });
  worker.addEventListener("fetch", (event) => {
    const request = event.request;
    if (
      request.method !== "GET" ||
      isPrivateRequest(request, worker.location.origin)
    )
      return;
    const url = new URL(request.url);
    if (request.mode === "navigate") {
      const network = Promise.resolve(event.preloadResponse).then(
        (preloaded) => preloaded ?? worker.fetch(request),
      );
      const refresh = network.then(async (response) => {
        if (response.ok && responseMatchesBuild(response, buildId)) {
          const cache = await worker.caches.open(version);
          await cache.put("/", response.clone());
        }
        return response;
      });
      event.waitUntil(refresh.then(() => undefined).catch(() => undefined));
      event.respondWith(
        worker.caches.open(version).then(async (cache) => {
          const cached = await cache.match("/");
          if (cached) return cached;
          return refresh;
        }),
      );
      return;
    }
    if (!isPublicCacheUrl(url.href, worker.location.origin)) return;
    event.respondWith(
      worker.caches.open(version).then(async (cache) => {
        const current = await cache.match(request);
        if (current) return current;
        const retained = url.pathname.startsWith("/_next/static/")
          ? await matchRetainedShell(request)
          : undefined;
        if (retained) {
          event.waitUntil(cache.put(request, retained.clone()));
          return retained;
        }
        const response = await worker.fetch(request);
        if (response.ok) await cache.put(request, response.clone());
        return response;
      }),
    );
  });
}
