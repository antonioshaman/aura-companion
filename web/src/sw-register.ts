/** Register the existing Workbox worker, but let each tab choose when to reload. */
type UpdateListener = (ready: boolean) => void;
let updateReady = false;
let registration: ServiceWorkerRegistration | undefined;
let reloadRequested = false;
let reloading = false;
const listeners = new Set<UpdateListener>();

function announceUpdate(): void {
  updateReady = true;
  for (const listener of listeners) listener(true);
}

function reloadOnce(): void {
  if (reloading) return;
  reloading = true;
  window.location.reload();
}

if (typeof navigator !== "undefined" && "serviceWorker" in navigator) {
  const serviceWorker = navigator.serviceWorker;
  // Workbox-window captures isUpdate at registration. On a first-install tab
  // it stays false, so its prompt helper may activate an update without a reload.
  // Native controllerchange also lets another tab update WITHOUT discarding
  // this tab's editor/draft. Only this tab's explicit Update grants reload.
  serviceWorker.addEventListener("controllerchange", () => {
    if (reloadRequested) reloadOnce();
  });
  void serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).then((reg) => {
    registration = reg;
    if (reg.waiting) announceUpdate();
    const observeInstalling = () => {
      const worker = reg.installing;
      if (!worker) return;
      worker.addEventListener("statechange", () => {
        if (worker.state !== "installed") return;
        if (serviceWorker.controller) announceUpdate();
        else console.log("[SW] Offline-ready: all assets precached");
      });
    };
    observeInstalling();
    reg.addEventListener("updatefound", observeInstalling);
    setInterval(() => { void reg.update().catch(() => { /* retry at the next interval */ }); }, 60 * 60 * 1000);
  }).catch((error: unknown) => console.warn("[SW] Registration failed", error));
}

export function isUpdateReady(): boolean { return updateReady; }
export function subscribeUpdateReady(listener: UpdateListener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** The worker activates only after explicit consent; this tab then reloads once. */
export function applyUpdate(): void {
  if (!updateReady || reloading) return;
  reloadRequested = true;
  if (registration?.waiting) registration.waiting.postMessage({ type: "SKIP_WAITING" });
  // Another tab may have activated the worker already. The notice remains an
  // explicit invitation to load its new document, never an automatic reload.
  else reloadOnce();
}
