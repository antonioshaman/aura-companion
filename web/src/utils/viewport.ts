/**
 * Viewport zoom policy (WCAG 1.4.4 Resize Text).
 *
 * index.html ships without maximum-scale, because Android Chrome honours it and
 * blocks pinch-zoom. iOS Safari ignores maximum-scale for pinch-zoom (since
 * iOS 10) but still uses it to skip the auto-zoom when an input under 16px gets
 * focus, so only iOS gets maximum-scale=1, added here at start-up.
 */
export interface NavigatorLike {
  userAgent: string;
  platform: string;
  maxTouchPoints: number;
}

/** iPhone/iPod/iPad, including iPadOS that reports a desktop Mac UA (touch points give it away). */
export function isIosDevice(nav: NavigatorLike): boolean {
  if (/iPhone|iPad|iPod/.test(nav.userAgent) || /iPhone|iPad|iPod/.test(nav.platform)) return true;
  return nav.platform === "MacIntel" && nav.maxTouchPoints > 1;
}

export function applyIosInputZoomGuard(doc: Document = document, nav: NavigatorLike = navigator): void {
  if (!isIosDevice(nav)) return;
  const meta = doc.querySelector<HTMLMetaElement>('meta[name="viewport"]');
  if (!meta || /maximum-scale/.test(meta.content)) return;
  meta.content = `${meta.content}, maximum-scale=1`;
}
