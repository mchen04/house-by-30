"use client";

import { RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { hasOpenBufferedEdit, subscribeToBufferedEdits } from "./document-exit";
import styles from "./financial-app.module.css";
import { hasDurabilityGap, subscribeToDurabilityGap } from "./sync-state";
import {
  canApplyPwaUpdate,
  reloadGuardAllows,
  UPDATE_CHECK_COOLDOWN_MS,
  UPDATE_CHECK_INTERVAL_MS,
  UPDATE_RELOAD_GUARD_MS,
} from "@/pwa/update-policy";

const SHELL_CACHE_PREFIX = "kyle-shell-";

function updateIsSafe(): boolean {
  return canApplyPwaUpdate({
    bufferedEdit: hasOpenBufferedEdit(),
    durabilityGap: hasDurabilityGap(),
    visible: document.visibilityState === "visible",
  });
}

async function clearDevelopmentWorkers(): Promise<void> {
  const registrations = await navigator.serviceWorker.getRegistrations();
  await Promise.all(
    registrations.map((registration) => registration.unregister()),
  );
  const keys = await caches.keys();
  await Promise.all(
    keys
      .filter((key) => key.startsWith(SHELL_CACHE_PREFIX))
      .map((key) => caches.delete(key)),
  );
}

export function PwaRuntime({ buildId }: { buildId: string }) {
  const [waiting, setWaiting] = useState<ServiceWorker | null>(null);
  const [safetyRevision, setSafetyRevision] = useState(0);
  const activationRequested = useRef(false);
  const controlledAtMount = useRef(false);
  const controllerReloadPending = useRef(false);
  const lastUpdateCheck = useRef(0);

  const announceSafetyChange = useCallback(
    () => setSafetyRevision((revision) => revision + 1),
    [],
  );

  const reloadOnce = useCallback((): boolean => {
    if (!updateIsSafe()) return false;
    const key = `house-by-30:pwa-reload:${buildId}`;
    const now = Date.now();
    if (!reloadGuardAllows(sessionStorage.getItem(key), now)) {
      window.setTimeout(announceSafetyChange, UPDATE_RELOAD_GUARD_MS);
      return false;
    }
    sessionStorage.setItem(key, String(now));
    window.location.reload();
    return true;
  }, [announceSafetyChange, buildId]);

  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    if (process.env.NODE_ENV !== "production") {
      void clearDevelopmentWorkers();
      return;
    }

    controlledAtMount.current = Boolean(navigator.serviceWorker.controller);
    void navigator.storage?.persist?.();

    const postClientReady = (worker?: ServiceWorker | null) =>
      worker?.postMessage({ type: "CLIENT_READY", buildId });

    const onWorkerMessage = (event: MessageEvent) => {
      if (event.data?.type !== "REPORT_CLIENT_BUILD") return;
      const source = event.source as ServiceWorker | null;
      source?.postMessage({ type: "CLIENT_BUILD", buildId });
    };

    const onControllerChange = () => {
      postClientReady(navigator.serviceWorker.controller);
      if (controlledAtMount.current || activationRequested.current) {
        controllerReloadPending.current = true;
        reloadOnce();
      }
      controlledAtMount.current = true;
    };

    navigator.serviceWorker.addEventListener("message", onWorkerMessage);
    navigator.serviceWorker.addEventListener(
      "controllerchange",
      onControllerChange,
    );

    let disposed = false;
    let interval: number | undefined;
    const eventCleanups: Array<() => void> = [];
    void navigator.serviceWorker
      .register("/sw.js", {
        scope: "/",
        type: "module",
        updateViaCache: "none",
      })
      .then(async (registration) => {
        if (disposed) return;
        if (registration.waiting) setWaiting(registration.waiting);
        registration.addEventListener("updatefound", () => {
          const worker = registration.installing;
          worker?.addEventListener("statechange", () => {
            if (
              worker.state === "installed" &&
              navigator.serviceWorker.controller
            )
              setWaiting(worker);
          });
        });

        const checkForUpdate = () => {
          const now = Date.now();
          if (
            !navigator.onLine ||
            now - lastUpdateCheck.current < UPDATE_CHECK_COOLDOWN_MS
          )
            return;
          lastUpdateCheck.current = now;
          void registration.update().catch(() => undefined);
        };
        const onPageShow = () => checkForUpdate();
        const onOnline = () => checkForUpdate();
        const onVisibility = () => {
          announceSafetyChange();
          if (document.visibilityState === "visible") checkForUpdate();
        };
        window.addEventListener("pageshow", onPageShow);
        window.addEventListener("online", onOnline);
        document.addEventListener("visibilitychange", onVisibility);
        eventCleanups.push(
          () => window.removeEventListener("pageshow", onPageShow),
          () => window.removeEventListener("online", onOnline),
          () => document.removeEventListener("visibilitychange", onVisibility),
        );
        interval = window.setInterval(checkForUpdate, UPDATE_CHECK_INTERVAL_MS);
        checkForUpdate();

        const ready = await navigator.serviceWorker.ready;
        if (disposed) return;
        const worker = navigator.serviceWorker.controller ?? ready.active;
        postClientReady(worker);
        const urls = performance
          .getEntriesByType("resource")
          .map((entry) => entry.name)
          .filter((url) => new URL(url).origin === window.location.origin);
        worker?.postMessage({
          type: "CACHE_URLS",
          urls: [window.location.href, ...urls],
        });
      })
      .catch(() => undefined);

    return () => {
      disposed = true;
      if (interval !== undefined) window.clearInterval(interval);
      for (const cleanup of eventCleanups) cleanup();
      navigator.serviceWorker.removeEventListener("message", onWorkerMessage);
      navigator.serviceWorker.removeEventListener(
        "controllerchange",
        onControllerChange,
      );
    };
  }, [announceSafetyChange, buildId, reloadOnce]);

  useEffect(() => {
    const onSafetyChange = () => announceSafetyChange();
    const unsubscribeBuffer = subscribeToBufferedEdits(onSafetyChange);
    const unsubscribeDurability = subscribeToDurabilityGap(onSafetyChange);
    return () => {
      unsubscribeBuffer();
      unsubscribeDurability();
    };
  }, [announceSafetyChange]);

  useEffect(() => {
    if (controllerReloadPending.current && reloadOnce()) return;
    if (!waiting || activationRequested.current || !updateIsSafe()) return;
    activationRequested.current = true;
    setWaiting(null);
    waiting.postMessage({ type: "SKIP_WAITING" });
  }, [reloadOnce, safetyRevision, waiting]);

  useEffect(() => {
    if (waiting) document.documentElement.dataset.updateReady = "true";
    else delete document.documentElement.dataset.updateReady;
    return () => {
      delete document.documentElement.dataset.updateReady;
    };
  }, [waiting]);

  if (!waiting) return null;
  return (
    <div className={styles.updateToast} role="status">
      <RefreshCw />
      <span className={styles.updateFull}>Update ready · saving first</span>
      <span className={styles.updateShort}>Updating soon</span>
    </div>
  );
}
