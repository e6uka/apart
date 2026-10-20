import alertIcon from "lucide-static/icons/circle-alert.svg";
import arrowLeftIcon from "lucide-static/icons/arrow-left.svg";
import checkCircleIcon from "lucide-static/icons/circle-check.svg";
import checkIcon from "lucide-static/icons/check.svg";
import chevronLeftIcon from "lucide-static/icons/chevron-left.svg";
import chevronRightIcon from "lucide-static/icons/chevron-right.svg";
import copyIcon from "lucide-static/icons/copy.svg";
import historyIcon from "lucide-static/icons/history.svg";
import loaderIcon from "lucide-static/icons/loader-circle.svg";
import refreshIcon from "lucide-static/icons/refresh-cw.svg";
import searchIcon from "lucide-static/icons/search.svg";
import settingsIcon from "lucide-static/icons/settings.svg";
import slidersIcon from "lucide-static/icons/sliders-horizontal.svg";
import trashIcon from "lucide-static/icons/trash-2.svg";
import xIcon from "lucide-static/icons/x.svg";
import type { DaemonInfo, RunBrowser, RunRecord, RunStarted } from "../../shared/protocol";

const ICONS = {
  alert: alertIcon,
  arrowLeft: arrowLeftIcon,
  checkCircle: checkCircleIcon,
  check: checkIcon,
  chevronLeft: chevronLeftIcon,
  chevronRight: chevronRightIcon,
  copy: copyIcon,
  history: historyIcon,
  loader: loaderIcon,
  refresh: refreshIcon,
  search: searchIcon,
  settings: settingsIcon,
  sliders: slidersIcon,
  trash: trashIcon,
  x: xIcon,
};

export type IconName = keyof typeof ICONS;

export function icon(name: IconName): string {
  return ICONS[name]
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/class="[^"]*"/, 'class="icon" aria-hidden="true" focusable="false"')
    .replace(/\s+/g, " ")
    .trim();
}

export type ConnectionState = "loading" | "connected" | "running" | "disconnected" | "rejected" | "replaced";

export interface ExtensionState {
  status: { state: string; detail?: string; at?: number } | null;
  daemon: DaemonInfo | null;
  current: RunStarted | null;
  runs: RunRecord[];
  port: number | null;
  defaultBrowser: RunBrowser | null;
}

export async function readState(): Promise<ExtensionState> {
  const stored = await chrome.storage.local.get(["status", "daemon", "current", "runs", "port", "defaultBrowser"]);
  return {
    status: (stored.status as ExtensionState["status"]) ?? null,
    daemon: (stored.daemon as DaemonInfo) ?? null,
    current: (stored.current as RunStarted) ?? null,
    runs: Array.isArray(stored.runs) ? (stored.runs as RunRecord[]) : [],
    port: typeof stored.port === "number" ? stored.port : null,
    defaultBrowser: stored.defaultBrowser === "headless" || stored.defaultBrowser === "chrome" ? stored.defaultBrowser : null,
  };
}

export function connectionState(state: ExtensionState): ConnectionState {
  const raw = state.status?.state;
  if (raw === "connected") return state.current ? "running" : "connected";
  if (raw === "rejected" || raw === "replaced") return raw;
  return "disconnected";
}

export function onStateChange(listener: () => void): void {
  chrome.storage.onChanged.addListener((_changes, area) => {
    if (area === "local") listener();
  });
}

const RELATIVE = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
const ABSOLUTE = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" });

export function relativeTime(at: number, now = Date.now()): string {
  const seconds = Math.round((at - now) / 1000);
  const abs = Math.abs(seconds);
  if (abs < 45) return "just now";
  if (abs < 3600) return RELATIVE.format(Math.round(seconds / 60), "minute");
  if (abs < 86400) return RELATIVE.format(Math.round(seconds / 3600), "hour");
  return RELATIVE.format(Math.round(seconds / 86400), "day");
}

export function absoluteTime(at: number): string {
  return ABSOLUTE.format(new Date(at));
}

export function duration(ms: number): string {
  if (ms < 1000) return `${Math.max(1, Math.round(ms))} ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)} s`;
  const minutes = Math.floor(ms / 60000);
  return `${minutes} min ${Math.round((ms % 60000) / 1000)} s`;
}

export function displayUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const host = parsed.host.replace(/^www\./, "");
    return parsed.pathname && parsed.pathname !== "/" ? `${host}${parsed.pathname}` : host;
  } catch {
    return url;
  }
}

export function runTitle(run: RunRecord): string {
  if (run.urls.length === 0) return "No pages opened";
  const first = displayUrl(run.urls[0]);
  return run.urls.length > 1 ? `${first} and ${run.urls.length - 1} more` : first;
}

export function runBrowser(run: RunRecord): RunBrowser {
  return run.browser === "headless" ? "headless" : "chrome";
}

export const BROWSER_LABELS: Record<RunBrowser, string> = { chrome: "Your Chrome", headless: "Headless" };

export function resultLabel(run: RunRecord): string {
  return run.ok ? "Done" : "Failed";
}

export function resultBadge(run: RunRecord): string {
  return `<span class="result ${run.ok ? "ok" : "failed"}">${icon(run.ok ? "checkCircle" : "alert")}${resultLabel(run)}</span>`;
}

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
}

const COPY: Record<ConnectionState, { tab: string; title: string; body: string }> = {
  loading: { tab: "Checking", title: "Checking the connection", body: "One moment." },
  connected: { tab: "Connected", title: "Ready", body: "Your terminal can use this browser. Tabs apart opens go in the pink apart group." },
  running: { tab: "Working", title: "Running a script", body: "Tabs it opens appear in the pink apart group and close when it finishes." },
  disconnected: { tab: "Offline", title: "Not connected", body: "Start apart in your terminal, then check again." },
  rejected: { tab: "Refused", title: "Connection refused", body: "The daemon did not accept this extension. Reinstall apart from its repository so the two match, then check again." },
  replaced: { tab: "Elsewhere", title: "Connected in another profile", body: "Another Chrome window or profile took over the connection. Close it, or check again to take it back here." },
};

export function renderStatusCard(root: HTMLElement, state: ExtensionState, options: { compact?: boolean } = {}): void {
  const kind: ConnectionState = state.status === null && state.daemon === null && root.dataset.state === undefined ? "loading" : connectionState(state);
  const previous = root.dataset.state;
  const copy = COPY[kind];
  root.dataset.state = kind;
  root.classList.toggle("settled", previous !== undefined && previous !== kind && (kind === "connected" || kind === "running"));
  const tabIcon = kind === "running" ? icon("loader") : kind === "connected" ? icon("check") : kind === "loading" ? "" : icon("alert");
  const port = state.daemon?.port ?? state.port ?? 27170;
  let extra = "";
  if (kind === "connected" || kind === "running") {
    const facts = [`<dt>Daemon</dt><dd>${escapeHtml(state.daemon?.version ?? "unknown")}</dd>`, `<dt>Port</dt><dd>${port}</dd>`];
    if (kind === "running" && state.current) facts.unshift(`<dt>Started</dt><dd>${escapeHtml(relativeTime(state.current.startedAt))}</dd>`);
    if (!options.compact) facts.push(`<dt>Extension</dt><dd>${escapeHtml(chrome.runtime.getManifest().version)}</dd>`);
    extra = `<dl class="status-facts">${facts.join("")}</dl>`;
  } else if (kind !== "loading") {
    const command = port === 27170 ? "apart doctor" : `apart daemon start --port ${port}`;
    extra = `
      <div class="command"><code>${escapeHtml(command)}</code><button class="button ghost" type="button" data-copy="${escapeHtml(command)}">${icon("copy")}<span>Copy</span></button></div>
      <div class="status-actions"><button class="button primary" type="button" data-action="connect">${icon("refresh")}<span>Check now</span></button></div>
      <p class="status-hint" role="status" aria-live="polite">It keeps checking on its own.</p>`;
  }
  root.innerHTML = `
    <span class="status-tab">${tabIcon}${copy.tab}</span>
    <h2 class="status-title">${copy.title}</h2>
    <p class="status-body">${copy.body}</p>
    ${extra}`;
}

export function bindStatusActions(root: HTMLElement): void {
  root.addEventListener("click", async (event) => {
    const target = (event.target as HTMLElement).closest("button");
    if (!target) return;
    const hint = root.querySelector<HTMLElement>(".status-hint");
    if (target.dataset.copy) {
      const label = target.querySelector("span");
      try {
        await navigator.clipboard.writeText(target.dataset.copy);
        if (label) label.textContent = "Copied";
      } catch {
        if (label) label.textContent = "Select and copy";
      }
      setTimeout(() => { if (label) label.textContent = "Copy"; }, 1600);
      return;
    }
    if (target.dataset.action === "connect") {
      target.setAttribute("disabled", "");
      if (hint) hint.textContent = "Checking…";
      try {
        await chrome.runtime.sendMessage({ type: "apart:connect" });
        await new Promise((resolve) => setTimeout(resolve, 1200));
        const state = await readState();
        if (hint && connectionState(state) === "disconnected") hint.textContent = "Still not reachable. Is apart running in your terminal?";
      } catch {
        if (hint) hint.textContent = "Could not reach the extension's background page. Reload the extension and try again.";
      } finally {
        target.removeAttribute("disabled");
      }
    }
  });
}

export function openExtensionPage(path: string): void {
  void chrome.tabs.create({ url: chrome.runtime.getURL(path) });
}
