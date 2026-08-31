import { useEffect, useState } from "react";
import { isUpdateReady, subscribeUpdateReady } from "./sw-register";

/** True once a new Service Worker version is installed and waiting to activate. */
export function useSwUpdate(): boolean {
  const [ready, setReady] = useState<boolean>(isUpdateReady);
  useEffect(() => subscribeUpdateReady(setReady), []);
  return ready;
}
