/**
 * Announce a waiting PWA update; apply it only on an explicit Update action.
 * Automatic reloads destroy the new-session form and unsaved editor content,
 * especially when a phone resumes after a deployment. Existing sessions remain
 * on the server; the visible notice lets the user choose when to reload.
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
    // Do not reload while the user is selecting a project or editing a file.
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
