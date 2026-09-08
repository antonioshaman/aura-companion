/**
 * Service Worker registration for production builds.
 *
 * Auto-applies updates: when a new SW finishes installing and parks in the
 * "waiting" state, onNeedRefresh immediately activates it (skipWaiting) and
 * reloads the page onto the fresh bundle. This is a deliberate reversal of the
 * earlier "prompt" model, where the tab kept running stale code until the user
 * clicked the UpdateAvailableBanner — in practice that stranded browsers on
 * pre-deploy bundles (a stale bundle after the stdio-transport change could not
 * render live frames), forcing a manual hard reload. Freshness wins because a
 * reload is cheap here: sessions persist server-side and the SW never
 * intercepts /ws/* or /api/*, so a WebSocket reconnect loses nothing but any
 * unsent composer text.
 *
 * The UpdateAvailableBanner plumbing (subscribeUpdateReady/applyUpdate) is kept
 * as an inert fallback so a listener can still observe the transition, but the
 * refresh no longer waits on a user gesture.
 *
 * In dev mode the virtual:pwa-register module is a no-op, so importing this file
 * has no effect during development.
 *
 * Note: a tab already running the OLD prompt-mode bundle will still show the
 * banner on the next update; only after it lands on this bundle once do future
 * updates apply automatically.
 */
import { registerSW } from "virtual:pwa-register";

type UpdateListener = (ready: boolean) => void;

let updateReady = false;
const listeners = new Set<UpdateListener>();

const updateSW = registerSW({
  onRegisteredSW(_swUrl: string, registration: ServiceWorkerRegistration | undefined) {
    if (registration) {
      // Check for SW updates every 60 minutes while the app is open.
      // Catches deployments that happen while a user has the app open.
      setInterval(() => {
        registration.update();
      }, 60 * 60 * 1000);
    }
  },
  onNeedRefresh() {
    updateReady = true;
    for (const listener of listeners) listener(true);
    // Auto-apply: activate the waiting SW and reload onto the fresh bundle
    // without waiting for a banner click.
    void updateSW(true);
  },
  onOfflineReady() {
    console.log("[SW] Offline-ready: all assets precached");
  },
});

/** Whether a new SW version is installed and waiting to activate. */
export function isUpdateReady(): boolean {
  return updateReady;
}

/** Subscribe to update-ready transitions. Returns an unsubscribe function. */
export function subscribeUpdateReady(listener: UpdateListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Activate the waiting SW and reload the page onto the new bundle. */
export function applyUpdate(): void {
  void updateSW(true);
}
