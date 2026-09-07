/**
 * Placement and dismissal for the admin dropdown panels.
 *
 * The panels are `position: fixed`, so they escape the modal's scrolling body
 * instead of being clipped by it. That means their coordinates have to be
 * computed against the viewport on open, on resize, and on any scroll.
 */

export interface PanelGeometryInput {
  trigger: HTMLElement;
  /** The field the panel lines up with, when it is wider than the trigger. */
  wrapper?: HTMLElement;
  /** Widest the panel may become; it never exceeds the viewport either. */
  maxWidth?: number;
  /** Height below which the panel prefers to open upward. */
  minRoomBelow?: number;
}

const VIEWPORT_GUTTER = 12;
const PANEL_GAP = 6;

/**
 * The inline style for one panel: a vertical anchor, a clamped left edge, and
 * `--picker-room`, the height available in the chosen direction. Rules cap
 * their scroll areas against that variable so a panel never runs off screen.
 */
export function panelGeometryStyle({
  trigger,
  wrapper,
  maxWidth = 500,
  minRoomBelow = 260,
}: PanelGeometryInput): string {
  const rect = trigger.getBoundingClientRect();
  const containerRect = wrapper?.getBoundingClientRect();
  const parentWidth = containerRect?.width ?? rect.width;
  const width = Math.min(maxWidth, parentWidth, window.innerWidth - VIEWPORT_GUTTER * 2);
  const preferredLeft = containerRect?.left ?? rect.left;
  const left = Math.min(Math.max(preferredLeft, VIEWPORT_GUTTER), window.innerWidth - width - VIEWPORT_GUTTER);
  const roomBelow = window.innerHeight - rect.bottom - PANEL_GAP - VIEWPORT_GUTTER;
  const roomAbove = rect.top - PANEL_GAP - VIEWPORT_GUTTER;
  const placeBelow = roomBelow >= minRoomBelow || roomBelow >= roomAbove;
  const room = Math.max(96, placeBelow ? roomBelow : roomAbove);
  const verticalPosition = placeBelow
    ? `top: ${rect.bottom + PANEL_GAP}px;`
    : `bottom: ${window.innerHeight - rect.top + PANEL_GAP}px;`;
  return `${verticalPosition} left: ${left}px; width: ${width}px; --picker-room: ${room}px;`;
}

export interface PanelListenerInput {
  /** Elements a pointer press may land in without closing the panel. */
  contains: () => Array<HTMLElement | undefined>;
  close: () => void;
  reposition: () => void;
}

/**
 * Binds the listeners an open panel needs, and returns their teardown.
 *
 * Scroll is captured so a panel repositions with any ancestor that scrolls, not
 * only the window.
 */
export function bindPanelListeners({ contains, close, reposition }: PanelListenerInput): () => void {
  const onPointerDown = (event: PointerEvent): void => {
    const target = event.target as Node;
    if (contains().some((element) => element?.contains(target))) return;
    close();
  };
  document.addEventListener("pointerdown", onPointerDown);
  window.addEventListener("resize", reposition);
  window.addEventListener("scroll", reposition, true);
  return () => {
    document.removeEventListener("pointerdown", onPointerDown);
    window.removeEventListener("resize", reposition);
    window.removeEventListener("scroll", reposition, true);
  };
}
