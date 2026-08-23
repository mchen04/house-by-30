export interface WorkerHeaders {
  get(name: string): string | null;
}

export interface WorkerRequest {
  headers?: WorkerHeaders;
  method: string;
  mode: string;
  url: string;
}

export interface WorkerResponse {
  clone(): WorkerResponse;
  headers?: WorkerHeaders;
  ok: boolean;
  text?(): Promise<string>;
}

interface WorkerCache {
  addAll(urls: string[]): Promise<unknown>;
  match(request: WorkerRequest | string): Promise<WorkerResponse | undefined>;
  put(
    request: WorkerRequest | string,
    response: WorkerResponse,
  ): Promise<unknown>;
}

interface WorkerClient {
  id: string;
  postMessage(message: unknown): void;
}

interface WorkerMessageEvent {
  data?: { buildId?: unknown; type?: string; urls?: unknown };
  source?: WorkerClient | null;
  waitUntil(work: Promise<unknown>): void;
}

interface WorkerFetchEvent {
  preloadResponse?: Promise<WorkerResponse | undefined>;
  request: WorkerRequest;
  respondWith(work: Promise<WorkerResponse | undefined>): void;
  waitUntil(work: Promise<unknown>): void;
}

export interface WorkerScope {
  caches: {
    delete(key: string): Promise<boolean>;
    keys(): Promise<string[]>;
    open(key: string): Promise<WorkerCache>;
  };
  clients: {
    claim(): Promise<unknown>;
    matchAll(options?: {
      includeUncontrolled?: boolean;
      type?: "window";
    }): Promise<WorkerClient[]>;
  };
  fetch(
    request: WorkerRequest | string,
    init?: { cache?: "no-store" },
  ): Promise<WorkerResponse>;
  location: { origin: string };
  registration?: { navigationPreload?: { enable(): Promise<unknown> } };
  skipWaiting(): Promise<unknown>;
  addEventListener(
    type: "install" | "activate",
    listener: (event: { waitUntil(work: Promise<unknown>): void }) => void,
  ): void;
  addEventListener(
    type: "message",
    listener: (event: WorkerMessageEvent) => void,
  ): void;
  addEventListener(
    type: "fetch",
    listener: (event: WorkerFetchEvent) => void,
  ): void;
}

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
] as const;

export function staticAssetUrls(html: string, origin: string): string[] {
  const urls = new Set<string>();
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

export function isPublicCacheUrl(value: string, origin: string): boolean {
  const parsed = new URL(value, origin);
  if (parsed.origin !== origin || parsed.searchParams.has("_rsc")) return false;
  if (parsed.pathname.startsWith("/_next/static/")) return true;
  return (
    parsed.search === "" &&
    PUBLIC_SHELL.includes(parsed.pathname as (typeof PUBLIC_SHELL)[number])
  );
}

function responseMatchesBuild(
  response: WorkerResponse,
  buildId: string,
): boolean {
  const responseBuild = response.headers?.get(BUILD_HEADER);
  return responseBuild === buildId;
}

function isPrivateRequest(request: WorkerRequest, origin: string): boolean {
  const url = new URL(request.url);
  return (
    url.origin !== origin ||
    url.pathname === "/api" ||
    url.pathname.startsWith("/api/") ||
    url.searchParams.has("_rsc") ||
    request.headers?.get("RSC") === "1"
  );
}

export function startServiceWorker(worker: WorkerScope, buildId: string): void {
  const version = `${SHELL_PREFIX}${buildId}`;
  const clientBuilds = new Map<string, string>();

  const liveClients = () =>
    worker.clients.matchAll({ includeUncontrolled: true, type: "window" });

  const matchRetainedShell = async (
    request: WorkerRequest | string,
  ): Promise<WorkerResponse | undefined> => {
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

  const deleteUnusedShells = async (): Promise<void> => {
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

  const requestClientBuilds = async (): Promise<void> => {
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
        const html = root.text ? await root.clone().text!() : "";
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
      (url): url is string =>
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
