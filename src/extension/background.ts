import { DEFAULT_PORT, PROTOCOL_VERSION, mergeRuns, type CompletedDownload, type DaemonToExt, type ExtRequest, type ExtToDaemon, type RunBrowser, type RunRecord, type TabInfo } from "../shared/protocol";

const ALARM_NAME = "apart-reconnect";
const GROUP_TITLE = "apart";

let socket: WebSocket | null = null;
let connecting: Promise<void> | null = null;
let storageQueue: Promise<unknown> = Promise.resolve();
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let retryAttempt = 0;
const RETRY_DELAYS_MS = [1000, 2000, 3000, 5000, 8000, 13000, 20000];
const attachedTabs = new Set<number>();
const createdTabs = new Set<number>();
const RECENT_DOWNLOAD_MS = 120000;
const recentDownloads: { at: number; urls: string[]; result: CompletedDownload | { error: string } }[] = [];
const downloadWaiters = new Set<{ url: string; settle: (result: CompletedDownload | { error: string }) => void }>();

function downloadResult(item: chrome.downloads.DownloadItem): CompletedDownload | { error: string } {
  if (item.state === "interrupted") return { error: `Download failed: ${item.error ?? "interrupted"}` };
  return { path: item.filename, url: item.finalUrl || item.url, mimeType: item.mime, bytes: item.fileSize };
}

function finishDownload(item: chrome.downloads.DownloadItem): void {
  if (attachedTabs.size === 0) return;
  const urls = [item.url, item.finalUrl].filter(Boolean);
  const result = downloadResult(item);
  const now = Date.now();
  while (recentDownloads.length && now - recentDownloads[0].at > RECENT_DOWNLOAD_MS) recentDownloads.shift();
  recentDownloads.push({ at: now, urls, result });
  for (const waiter of Array.from(downloadWaiters)) {
    if (!urls.includes(waiter.url)) continue;
    downloadWaiters.delete(waiter);
    waiter.settle(result);
  }
}

function expectDownload(url: string, timeoutMs: number): Promise<CompletedDownload> {
  const done = recentDownloads.find((entry) => entry.urls.includes(url));
  const unwrap = (result: CompletedDownload | { error: string }) => {
    if ("error" in result) throw new Error(result.error);
    return result;
  };
  if (done) {
    recentDownloads.splice(recentDownloads.indexOf(done), 1);
    return Promise.resolve(done.result).then(unwrap);
  }
  return new Promise<CompletedDownload | { error: string }>((resolve) => {
    const waiter = { url, settle: (result: CompletedDownload | { error: string }) => { clearTimeout(timer); resolve(result); } };
    const timer = setTimeout(() => {
      downloadWaiters.delete(waiter);
      resolve({ error: `Download of ${url} did not finish within ${Math.round(timeoutMs / 1000)}s` });
    }, timeoutMs);
    downloadWaiters.add(waiter);
  }).then(unwrap);
}

async function getPort(): Promise<number> {
  const { port } = await chrome.storage.local.get("port");
  return typeof port === "number" && port > 0 ? port : DEFAULT_PORT;
}

async function setStatus(state: string, detail = ""): Promise<void> {
  await chrome.storage.local.set({ status: { state, detail, at: Date.now() } });
}

function queueStorage<T>(task: () => Promise<T>): Promise<T> {
  const next = storageQueue.then(task, task);
  storageQueue = next.catch(() => undefined);
  return next;
}

async function historyClearedAt(): Promise<number> {
  const { historyClearedAt: at } = await chrome.storage.local.get("historyClearedAt");
  return typeof at === "number" ? at : 0;
}

function recordRuns(incoming: RunRecord[], clearCurrent: boolean): Promise<void> {
  return queueStorage(async () => {
    const { runs } = await chrome.storage.local.get("runs");
    const merged = mergeRuns(Array.isArray(runs) ? (runs as RunRecord[]) : [], incoming, await historyClearedAt());
    const update: Record<string, unknown> = { runs: merged };
    if (clearCurrent) update.current = null;
    await chrome.storage.local.set(update);
  });
}

function send(message: ExtToDaemon): void {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function toInfo(tab: chrome.tabs.Tab): TabInfo {
  return { tabId: tab.id ?? -1, url: tab.url ?? tab.pendingUrl ?? "", title: tab.title ?? "", active: Boolean(tab.active), windowId: tab.windowId };
}

async function pickWindowId(): Promise<number> {
  const focused = await chrome.windows.getLastFocused({ windowTypes: ["normal"] }).catch(() => null);
  if (focused?.id !== undefined) return focused.id;
  const all = await chrome.windows.getAll({ windowTypes: ["normal"] });
  if (all[0]?.id !== undefined) return all[0].id;
  const created = await chrome.windows.create({ focused: false });
  if (created?.id === undefined) throw new Error("Could not find or create a browser window");
  return created.id;
}

async function groupTab(tab: chrome.tabs.Tab): Promise<void> {
  if (tab.id === undefined || !chrome.tabGroups) return;
  try {
    const existing = await chrome.tabGroups.query({ title: GROUP_TITLE, windowId: tab.windowId });
    const groupId = await chrome.tabs.group({ tabIds: tab.id, ...(existing[0] ? { groupId: existing[0].id } : {}) });
    if (!existing[0]) await chrome.tabGroups.update(groupId, { title: GROUP_TITLE, color: "pink", collapsed: false });
  } catch {
    return;
  }
}

async function detachTab(tabId: number): Promise<void> {
  if (!attachedTabs.has(tabId)) return;
  attachedTabs.delete(tabId);
  await chrome.debugger.detach({ tabId }).catch(() => undefined);
}

async function closeCreatedTabs(): Promise<void> {
  const ids = Array.from(createdTabs);
  createdTabs.clear();
  await Promise.allSettled(ids.map((tabId) => chrome.tabs.remove(tabId)));
}

async function detachAll(): Promise<void> {
  await Promise.allSettled(Array.from(attachedTabs).map((tabId) => detachTab(tabId)));
}

async function dispatch(request: ExtRequest): Promise<unknown> {
  const params = (request.params ?? {}) as Record<string, any>;
  switch (request.method) {
    case "tabs.list":
      return (await chrome.tabs.query({})).filter((tab) => tab.id !== undefined).map(toInfo);
    case "tabs.create": {
      const windowId = await pickWindowId();
      const tab = await chrome.tabs.create({ url: String(params.url ?? "about:blank"), active: false, windowId });
      if (tab.id === undefined) throw new Error("Chrome did not return a tab id");
      createdTabs.add(tab.id);
      await groupTab(tab);
      return toInfo(tab);
    }
    case "tabs.close": {
      const tabId = Number(params.tabId);
      await detachTab(tabId);
      createdTabs.delete(tabId);
      await chrome.tabs.remove(tabId).catch(() => undefined);
      return true;
    }
    case "tabs.active": {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      return tab && tab.id !== undefined ? toInfo(tab) : null;
    }
    case "tabs.activate": {
      const tabId = Number(params.tabId);
      const tab = await chrome.tabs.update(tabId, { active: true });
      if (tab?.windowId !== undefined) await chrome.windows.update(tab.windowId, { focused: true });
      return true;
    }
    case "debugger.attach": {
      const tabId = Number(params.tabId);
      if (!attachedTabs.has(tabId)) {
        await chrome.debugger.attach({ tabId }, "1.3");
        attachedTabs.add(tabId);
      }
      return true;
    }
    case "debugger.detach":
      await detachTab(Number(params.tabId));
      return true;
    case "debugger.send": {
      const target: chrome.debugger.DebuggerSession = typeof params.sessionId === "string" ? { tabId: Number(params.tabId), sessionId: params.sessionId } : { tabId: Number(params.tabId) };
      return chrome.debugger.sendCommand(target, String(params.method), params.params ?? {});
    }
    case "downloads.enable":
      if (!chrome.downloads) throw new Error("Reload the apart extension in chrome://extensions so it can save downloads.");
      return { mode: "relay" };
    case "downloads.expect":
      if (!chrome.downloads) throw new Error("Reload the apart extension in chrome://extensions so it can save downloads.");
      return expectDownload(String(params.url), Number(params.timeoutMs) || 600000);
    default:
      throw new Error(`Unsupported method: ${String(request.method)}`);
  }
}

function reply(ws: WebSocket, message: ExtToDaemon): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
}

async function handleMessage(ws: WebSocket, message: DaemonToExt): Promise<void> {
  if ("type" in message) {
    if (message.type === "ping") reply(ws, { type: "pong" });
    else if (message.type === "welcome") {
      retryAttempt = 0;
      await chrome.storage.local.set({ daemon: message.daemon, current: null });
      await setStatus("connected");
    } else if (message.type === "run-started") await chrome.storage.local.set({ current: message.run });
    else if (message.type === "run-finished") await recordRuns([message.run], message.run.browser !== "headless");
    else if (message.type === "history") await recordRuns(message.runs, false);
    else if (message.type === "config") await chrome.storage.local.set({ defaultBrowser: message.defaultBrowser });
    else if (message.type === "run-ended") await chrome.storage.local.set({ current: null });
    return;
  }
  try {
    reply(ws, { id: message.id, ok: true, result: await dispatch(message) });
  } catch (error) {
    reply(ws, { id: message.id, ok: false, error: error instanceof Error ? error.message : String(error) });
  }
}

function scheduleRetry(): void {
  if (retryTimer) return;
  const delay = RETRY_DELAYS_MS[Math.min(retryAttempt, RETRY_DELAYS_MS.length - 1)];
  retryAttempt += 1;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    void connect();
  }, delay);
}

function connect(): Promise<void> {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return Promise.resolve();
  connecting ??= openSocket().finally(() => {
    connecting = null;
  });
  return connecting;
}

async function openSocket(): Promise<void> {
  const port = await getPort();
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ext`);
  socket = ws;
  ws.onopen = () => {
    void historyClearedAt().then((clearedAt) => {
      ws.send(JSON.stringify({ type: "hello", version: PROTOCOL_VERSION, extensionVersion: chrome.runtime.getManifest().version, ...(clearedAt ? { historyClearedAt: clearedAt } : {}) }));
    });
  };
  ws.onmessage = (event) => {
    let parsed: DaemonToExt;
    try {
      parsed = JSON.parse(String(event.data)) as DaemonToExt;
    } catch {
      return;
    }
    void handleMessage(ws, parsed);
  };
  ws.onclose = (event) => {
    if (socket !== ws) return;
    socket = null;
    void detachAll();
    void closeCreatedTabs();
    const state = event.code === 1012 ? "replaced" : event.code === 4003 ? "rejected" : "disconnected";
    void chrome.storage.local.set({ current: null });
    if (event.code !== 1012 && event.code !== 4003) scheduleRetry();
    void setStatus(state, event.reason || `No daemon answered on port ${port}.`);
  };
  ws.onerror = () => undefined;
}

function reconnect(): void {
  if (socket) {
    const current = socket;
    socket = null;
    current.close(1000, "settings changed");
  }
  void connect();
}

async function ensureAlarm(): Promise<void> {
  const existing = await chrome.alarms.get(ALARM_NAME);
  if (!existing) await chrome.alarms.create(ALARM_NAME, { periodInMinutes: 0.5 });
}

chrome.runtime.onInstalled.addListener(() => {
  void ensureAlarm();
  void connect();
});
chrome.runtime.onStartup.addListener(() => {
  void ensureAlarm();
  void connect();
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) void connect();
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.port) reconnect();
  const clearedAt = changes.historyClearedAt?.newValue;
  if (typeof clearedAt === "number") send({ type: "clear-history", before: clearedAt });
});
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "apart:connect") {
    void connect().then(() => sendResponse({ ok: true }), (error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }
  if (message?.type === "apart:set-default-browser") {
    if (socket?.readyState !== WebSocket.OPEN) {
      sendResponse({ ok: false, error: "apart is not connected" });
      return false;
    }
    send({ type: "set-default-browser", browser: message.browser as RunBrowser });
    sendResponse({ ok: true });
    return false;
  }
  return false;
});
chrome.debugger.onEvent.addListener((source, method, params) => {
  if (source.tabId !== undefined) send({ type: "event", tabId: source.tabId, ...(source.sessionId ? { sessionId: source.sessionId } : {}), method, params });
});
chrome.downloads?.onChanged.addListener((delta) => {
  if (delta.state?.current !== "complete" && delta.state?.current !== "interrupted") return;
  void chrome.downloads.search({ id: delta.id }).then(([item]) => {
    if (item) finishDownload(item);
  });
});
chrome.debugger.onDetach.addListener((source, reason) => {
  if (source.tabId === undefined) return;
  attachedTabs.delete(source.tabId);
  send({ type: "detached", tabId: source.tabId, reason });
});
chrome.tabs.onRemoved.addListener((tabId) => {
  createdTabs.delete(tabId);
  attachedTabs.delete(tabId);
});

void ensureAlarm();
void connect();
