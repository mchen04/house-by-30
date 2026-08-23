import { describe, expect, it, vi } from "vitest";
import { renderServiceWorker } from "./service-worker";
import {
  isPublicCacheUrl,
  startServiceWorker,
  staticAssetUrls,
  type WorkerRequest,
  type WorkerResponse,
  type WorkerScope,
} from "./service-worker-runtime";

interface TestEvent {
  data?: { buildId?: unknown; type?: string; urls?: unknown };
  preloadResponse?: Promise<WorkerResponse | undefined>;
  request?: WorkerRequest;
  respondWith?(work: Promise<WorkerResponse | undefined>): void;
  source?: { id: string; postMessage(message: unknown): void } | null;
  waitUntil(work: Promise<unknown>): void;
}

type Listener = (event: TestEvent) => void;

function response(
  body = "",
  buildId: string | null = "current",
): WorkerResponse & { headers: Headers } {
  const headers = new Headers();
  if (buildId) headers.set("X-House-By-30-Build", buildId);
  return {
    ok: true,
    headers,
    clone: () => response(body, buildId),
    text: async () => body,
  };
}

function workerFixture(
  options: {
    clients?: Array<{ id: string; postMessage: ReturnType<typeof vi.fn> }>;
    currentMatch?: WorkerResponse;
    retainedMatch?: WorkerResponse;
    network?: () => Promise<WorkerResponse>;
  } = {},
) {
  const listeners = new Map<string, Listener>();
  const addAll = vi.fn(async (urls: string[]) => {
    void urls;
  });
  const put = vi.fn(
    async (request: unknown, cachedResponse: WorkerResponse) => {
      void request;
      void cachedResponse;
    },
  );
  const cacheMatch = vi.fn(async () => options.currentMatch);
  const retainedCacheMatch = vi.fn(async () => options.retainedMatch);
  const deleteCache = vi.fn(async () => true);
  const claim = vi.fn(async () => undefined);
  const navigationPreload = vi.fn(async () => undefined);
  const fetch = vi.fn(
    options.network ?? (async () => response("<html></html>")),
  );
  const clients = options.clients ?? [];
  const scope = {
    caches: {
      keys: vi.fn(async () => [
        "kyle-shell-old",
        "kyle-shell-current",
        "unrelated-cache",
      ]),
      delete: deleteCache,
      open: vi.fn(async (key: string) => ({
        addAll,
        put,
        match: key === "kyle-shell-old" ? retainedCacheMatch : cacheMatch,
      })),
    },
    clients: {
      claim,
      matchAll: vi.fn(async () => clients),
    },
    fetch,
    location: { origin: "https://example.test" },
    registration: { navigationPreload: { enable: navigationPreload } },
    skipWaiting: vi.fn(async () => undefined),
    addEventListener: (name: string, listener: Listener) =>
      listeners.set(name, listener),
  } as unknown as WorkerScope;
  startServiceWorker(scope, "current");
  return {
    addAll,
    cacheMatch,
    claim,
    clients,
    deleteCache,
    fetch,
    listeners,
    navigationPreload,
    openCache: scope.caches.open,
    put,
    retainedCacheMatch,
    scope,
  };
}

function eventWork(listener: Listener): Promise<unknown> {
  let work: Promise<unknown> | undefined;
  listener({
    waitUntil: (promise: Promise<unknown>) => {
      work = promise;
    },
  });
  if (!work) throw new Error("The event did not retain its work");
  return work;
}

describe("versioned service worker", () => {
  it("changes script bytes and cache identity with the build ID", () => {
    const first = renderServiceWorker("build-a");
    const second = renderServiceWorker("build-b");

    expect(first).not.toBe(second);
    expect(first).toContain('self, "build-a"');
    expect(second).toContain('self, "build-b"');
    expect(first).toContain('from "/sw-runtime.js"');
  });

  it("finds only static assets in the generated shell", () => {
    const html = [
      '<script src="/_next/static/chunks/app.js"></script>',
      '<link href="/_next/static/app.css?v=1&amp;x=2">',
      '<a href="/api/bootstrap">private</a>',
    ].join("");

    expect(staticAssetUrls(html, "https://example.test")).toEqual([
      "/_next/static/chunks/app.js",
      "/_next/static/app.css?v=1&x=2",
    ]);
    expect(isPublicCacheUrl("/api/bootstrap", "https://example.test")).toBe(
      false,
    );
    expect(isPublicCacheUrl("/?_rsc=private", "https://example.test")).toBe(
      false,
    );
    expect(isPublicCacheUrl("/?invite=private", "https://example.test")).toBe(
      false,
    );
    expect(
      isPublicCacheUrl(
        "https://other.test/_next/static/app.js",
        "https://example.test",
      ),
    ).toBe(false);
  });

  it("installs the shell and its initial static chunks together", async () => {
    const shell = response(
      '<script src="/_next/static/chunks/app.js"></script>',
    );
    const fixture = workerFixture({ network: async () => shell });

    await eventWork(fixture.listeners.get("install")!);

    expect(fixture.fetch).toHaveBeenCalledWith("/", { cache: "no-store" });
    expect(fixture.put).toHaveBeenCalledWith("/", expect.any(Object));
    expect(fixture.addAll).toHaveBeenCalledWith(
      expect.arrayContaining(["/_next/static/chunks/app.js"]),
    );
    expect(fixture.addAll.mock.calls[0][0]).not.toContain("/api/bootstrap");

    const missingHeader = workerFixture({
      network: async () => response("<html></html>", null),
    });
    await expect(
      eventWork(missingHeader.listeners.get("install")!),
    ).rejects.toThrow("does not match");
  });

  it("keeps an old shell until every live page reports the current build", async () => {
    const client = { id: "page-a", postMessage: vi.fn() };
    const fixture = workerFixture({ clients: [client] });

    await eventWork(fixture.listeners.get("activate")!);
    expect(fixture.claim).toHaveBeenCalledOnce();
    expect(fixture.navigationPreload).toHaveBeenCalledOnce();
    expect(client.postMessage).toHaveBeenCalledWith({
      type: "REPORT_CLIENT_BUILD",
      buildId: "current",
    });
    expect(fixture.deleteCache).not.toHaveBeenCalled();

    await eventWork((event) =>
      fixture.listeners.get("message")!({
        ...event,
        source: client,
        data: { type: "CLIENT_BUILD", buildId: "old" },
      }),
    );
    expect(fixture.deleteCache).not.toHaveBeenCalled();

    await eventWork((event) =>
      fixture.listeners.get("message")!({
        ...event,
        source: client,
        data: { type: "CLIENT_READY", buildId: "current" },
      }),
    );
    expect(fixture.deleteCache).toHaveBeenCalledWith("kyle-shell-old");
    expect(fixture.deleteCache).not.toHaveBeenCalledWith("unrelated-cache");
  });

  it("serves a cached navigation before its network refresh finishes", async () => {
    const cached = response("old shell");
    let finishNetwork = () => undefined as void;
    const network = new Promise<WorkerResponse>((resolve) => {
      finishNetwork = () => resolve(response("fresh shell"));
    });
    const fixture = workerFixture({
      currentMatch: cached,
      network: () => network,
    });
    let fetchWork: Promise<WorkerResponse | undefined> | undefined;
    let background: Promise<unknown> | undefined;

    fixture.listeners.get("fetch")!({
      request: {
        method: "GET",
        mode: "navigate",
        url: "https://example.test/",
      },
      respondWith: (work: Promise<WorkerResponse | undefined>) => {
        fetchWork = work;
      },
      waitUntil: (work: Promise<unknown>) => {
        background = work;
      },
    });

    await expect(fetchWork).resolves.toBe(cached);
    expect(fixture.put).not.toHaveBeenCalled();
    finishNetwork();
    await background;
    expect(fixture.put).toHaveBeenCalledWith("/", expect.any(Object));
  });

  it("ignores private fetches and filters client cache requests", async () => {
    const retained = response("retained chunk");
    const fixture = workerFixture({ retainedMatch: retained });
    const respondWith = vi.fn();
    const waitUntil = vi.fn();
    const fetchListener = fixture.listeners.get("fetch")!;

    for (const url of [
      "https://example.test/api/bootstrap",
      "https://example.test/?_rsc=private",
    ])
      fetchListener({
        request: { method: "GET", mode: "cors", url },
        respondWith,
        waitUntil,
      });
    expect(respondWith).not.toHaveBeenCalled();

    await eventWork((event) =>
      fixture.listeners.get("message")!({
        ...event,
        data: {
          type: "CACHE_URLS",
          urls: [
            "https://example.test/",
            "https://example.test/_next/static/app.js",
            "https://example.test/api/bootstrap",
            "https://example.test/?_rsc=private",
            "https://other.test/_next/static/other.js",
          ],
        },
      }),
    );
    expect(fixture.addAll).toHaveBeenCalledWith([
      "https://example.test/",
      "https://example.test/_next/static/app.js",
    ]);

    let staticResponse: Promise<WorkerResponse | undefined> | undefined;
    fetchListener({
      request: {
        method: "GET",
        mode: "cors",
        url: "https://example.test/_next/static/old.js",
      },
      respondWith: (work) => {
        staticResponse = work;
      },
      waitUntil,
    });
    await expect(staticResponse).resolves.toBe(retained);
    expect(fixture.retainedCacheMatch).toHaveBeenCalledOnce();
    expect(fixture.openCache).not.toHaveBeenCalledWith("unrelated-cache");
  });
});
