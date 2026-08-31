/**
 * Service Worker registration for production builds.
 *
 * Uses vite-plugin-pwa's "prompt" mode: when a new SW is detected it downloads
 * and installs, then parks in the "waiting" state instead of activating. The
 * open page keeps running the bundle it loaded with until the user opts in via
 * the update toaster (UpdateAvailableBanner), which calls applyUpdate() →
 * skipWaiting + reload. This prevents a silent cache swap from leaving a tab on
 * stale code after a frontend deploy.
 *
 * In dev mode the virtual:pwa-register module is a no-op, so importing this file
 * has no effect during development.
 *
 * Edge cases:
 * - Multiple tabs: applyUpdate reloads the calling tab; other tabs pick up the
 *   new SW on their next navigation. WebSocket connections are unaffected (the
 *   SW never intercepts /ws/* or /api/* routes).
 * - First-time visitors: app loads from network; SW installs in background.
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
