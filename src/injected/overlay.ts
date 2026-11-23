const TAG = "apart-overlay";
const SVG_NS = "http://www.w3.org/2000/svg";
const TTL_MS = 8000;
const PASSTHROUGH_MS = 1200;

const STYLES = `
:host {
  all: initial !important;
  position: fixed !important;
  inset: 0 !important;
  width: auto !important;
  height: auto !important;
  margin: 0 !important;
  padding: 0 !important;
  border: 0 !important;
  background: transparent !important;
  overflow: visible !important;
  pointer-events: none !important;
  z-index: 2147483647 !important;
  display: block !important;
  visibility: visible !important;
  opacity: 1 !important;
  transform: none !important;
  filter: none !important;
  contain: strict !important;
}
:host([data-hidden]) { display: none !important; }
@media print { :host { display: none !important; } }
.glow {
  position: fixed;
  inset: 0;
  pointer-events: none;
  box-shadow: inset 0 0 0 2px rgba(196, 48, 124, 0.85), inset 0 0 32px 6px rgba(196, 48, 124, 0.38);
  animation: breathe 2.4s ease-in-out infinite;
  transition: box-shadow 240ms ease-out;
}
.paused .glow {
  box-shadow: inset 0 0 0 2px rgba(110, 98, 115, 0.7);
  animation: none;
}
@keyframes breathe { 0%, 100% { opacity: 1; } 50% { opacity: 0.55; } }
.cursor {
  position: fixed;
  left: 0;
  top: 0;
  width: 22px;
  height: 22px;
  pointer-events: none;
  opacity: 0;
  transition: transform 180ms cubic-bezier(0.2, 0.8, 0.2, 1), opacity 160ms ease-out;
  filter: drop-shadow(0 1px 2px rgba(36, 27, 44, 0.45));
}
.cursor.shown { opacity: 1; }
.paused .cursor.shown { opacity: 0.35; }
.ripple {
  position: fixed;
  left: 0;
  top: 0;
  width: 28px;
  height: 28px;
  margin: -14px 0 0 -14px;
  border-radius: 50%;
  border: 2px solid rgba(196, 48, 124, 0.9);
  background: rgba(196, 48, 124, 0.18);
  pointer-events: none;
}
.pill {
  position: fixed;
  left: 50%;
  bottom: 16px;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 6px 6px 14px;
  border-radius: 999px;
  background: rgba(36, 27, 44, 0.94);
  color: #F6EEF3;
  font: 500 13px/1.2 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  letter-spacing: 0;
  white-space: nowrap;
  box-shadow: 0 12px 32px -8px rgba(36, 27, 44, 0.45), 0 2px 6px rgba(36, 27, 44, 0.2);
  pointer-events: auto;
  user-select: none;
  transition: opacity 160ms ease-out;
}
.pill.passthrough { pointer-events: none; opacity: 0.25; }
.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #EE6AAA;
  flex: none;
  animation: breathe 1.6s ease-in-out infinite;
}
.paused .dot { background: #B3A6B4; animation: none; }
button {
  all: unset;
  box-sizing: border-box;
  min-height: 28px;
  padding: 6px 12px;
  border-radius: 999px;
  background: #F6EEF3;
  color: #241B2C;
  font: 600 12px/1.3 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  cursor: pointer;
  transition: background-color 120ms ease-out;
}
button:hover { background: #FFFFFF; }
button:focus-visible { outline: 2px solid #EE6AAA; outline-offset: 2px; }
.paused button { background: #C4307C; color: #FFFFFF; }
.paused button:hover { background: #AB266B; }
@media (prefers-reduced-motion: reduce) {
  .glow, .dot { animation: none; }
  .cursor { transition: opacity 160ms ease-out; }
}
`;

type State = { paused: boolean; cursor?: { x: number; y: number } | null };
type Request = "pause" | "resume" | null;

interface Parts {
  host: HTMLElement;
  root: HTMLDivElement;
  cursor: SVGSVGElement;
  pill: HTMLDivElement;
  label: HTMLSpanElement;
  button: HTMLButtonElement;
}

let parts: Parts | null = null;
let pending: Request = null;
let paused = false;
let expiry: ReturnType<typeof setTimeout> | null = null;
let passthrough: ReturnType<typeof setTimeout> | null = null;
let sheet: CSSStyleSheet | null = null;

function reducedMotion(): boolean {
  return matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function buildCursor(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 22 22");
  svg.setAttribute("width", "22");
  svg.setAttribute("height", "22");
  svg.setAttribute("class", "cursor");
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", "M3 2.5 L3 18 L7.4 14 L10.4 20.5 L13.4 19.2 L10.5 12.9 L16.5 12.6 Z");
  path.setAttribute("fill", "#C4307C");
  path.setAttribute("stroke", "#FFFFFF");
  path.setAttribute("stroke-width", "1.6");
  path.setAttribute("stroke-linejoin", "round");
  svg.appendChild(path);
  return svg;
}

function build(): Parts {
  const host = document.createElement(TAG);
  const shadow = host.attachShadow({ mode: "closed" });
  sheet ??= new CSSStyleSheet();
  sheet.replaceSync(STYLES);
  shadow.adoptedStyleSheets = [sheet];
  const root = document.createElement("div");
  const glow = document.createElement("div");
  glow.className = "glow";
  const cursor = buildCursor();
  const pill = document.createElement("div");
  pill.className = "pill";
  pill.setAttribute("role", "status");
  const dot = document.createElement("span");
  dot.className = "dot";
  const label = document.createElement("span");
  const button = document.createElement("button");
  button.type = "button";
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    pending = paused ? "resume" : "pause";
    render(!paused);
  });
  for (const type of ["mousedown", "mouseup", "pointerdown", "pointerup", "keydown", "keyup"]) {
    pill.addEventListener(type, (event) => event.stopPropagation());
  }
  pill.append(dot, label, button);
  root.append(glow, cursor, pill);
  shadow.appendChild(root);
  return { host, root, cursor, pill, label, button };
}

function topModal(): Element | null {
  const modals = Array.from(document.querySelectorAll("dialog")).filter((dialog) => dialog.matches(":modal"));
  return modals[modals.length - 1] ?? null;
}

function raise(host: HTMLElement): void {
  const popover = host as HTMLElement & { showPopover?: () => void; hidePopover?: () => void };
  if (typeof popover.showPopover !== "function") return;
  host.setAttribute("popover", "manual");
  try {
    if (host.matches(":popover-open")) popover.hidePopover?.();
    popover.showPopover();
  } catch {}
}

function mount(): Parts {
  const target = topModal() ?? document.documentElement;
  if (parts && parts.host.isConnected && parts.host.parentNode === target) return parts;
  for (const stale of Array.from(document.querySelectorAll(TAG))) if (stale !== parts?.host) stale.remove();
  parts ??= build();
  target.appendChild(parts.host);
  raise(parts.host);
  return parts;
}

function render(state: boolean): void {
  if (!parts) return;
  parts.root.className = state ? "paused" : "";
  parts.label.textContent = state ? "You're in control" : "apart is working";
  parts.button.textContent = state ? "Resume" : "Take over";
  parts.button.setAttribute("aria-label", state ? "Hand control back to apart" : "Pause apart and take over this tab");
}

function placeCursor(x: number, y: number): void {
  if (!parts) return;
  parts.cursor.style.setProperty("transform", `translate(${Math.round(x) - 3}px, ${Math.round(y) - 2}px)`);
  parts.cursor.classList.add("shown");
}

function tick(state: State): Request {
  const current = mount();
  if (pending === null || (pending === "pause") === state.paused) {
    pending = null;
    paused = state.paused;
    render(paused);
  }
  if (state.cursor && !current.cursor.classList.contains("shown")) placeCursor(state.cursor.x, state.cursor.y);
  if (expiry) clearTimeout(expiry);
  expiry = setTimeout(remove, TTL_MS);
  return pending;
}

function point(x: number, y: number, press: boolean): void {
  const current = mount();
  placeCursor(x, y);
  const rect = current.pill.getBoundingClientRect();
  if (x >= rect.left - 12 && x <= rect.right + 12 && y >= rect.top - 12 && y <= rect.bottom + 12) {
    current.pill.classList.add("passthrough");
    if (passthrough) clearTimeout(passthrough);
    passthrough = setTimeout(() => current.pill.classList.remove("passthrough"), PASSTHROUGH_MS);
  }
  if (!press) return;
  const ripple = document.createElement("div");
  ripple.className = "ripple";
  ripple.style.setProperty("transform", `translate(${Math.round(x)}px, ${Math.round(y)}px)`);
  current.root.appendChild(ripple);
  const frames = reducedMotion()
    ? [{ opacity: 1 }, { opacity: 0 }]
    : [{ transform: `translate(${Math.round(x)}px, ${Math.round(y)}px) scale(0.4)`, opacity: 1 }, { transform: `translate(${Math.round(x)}px, ${Math.round(y)}px) scale(1.6)`, opacity: 0 }];
  const animation = ripple.animate(frames, { duration: 420, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" });
  animation.onfinish = () => ripple.remove();
  setTimeout(() => ripple.remove(), 1000);
}

function hide(): Promise<void> {
  if (!parts?.host.isConnected) return Promise.resolve();
  parts.host.setAttribute("data-hidden", "");
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, 120);
    requestAnimationFrame(() => requestAnimationFrame(() => {
      clearTimeout(timer);
      resolve();
    }));
  });
}

function show(): void {
  parts?.host.removeAttribute("data-hidden");
}

function remove(): void {
  if (expiry) clearTimeout(expiry);
  expiry = null;
  pending = null;
  parts?.host.remove();
}

export const overlay = { tick, point, hide, show, remove };
