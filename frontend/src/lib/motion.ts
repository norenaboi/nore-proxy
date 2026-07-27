export function motionDuration(duration: number): number {
  if (typeof window === "undefined" || !window.matchMedia) return duration;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : duration;
}
