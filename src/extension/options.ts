import { HEADLESS, isExtensionBrowserName } from "../shared/browsers";
import { DEFAULT_PORT, type RunBrowser } from "../shared/protocol";
import { bindStatusActions, browserLabel, connectionState, escapeHtml, icon, onStateChange, readState, renderStatusCard, type ExtensionState } from "./ui/common";

const statusRoot = document.getElementById("status") as HTMLElement;
const form = document.getElementById("port-form") as HTMLFormElement;
const portInput = document.getElementById("port") as HTMLInputElement;
const saveButton = form.querySelector<HTMLButtonElement>("button[type=submit]")!;
const portMessage = document.getElementById("port-message") as HTMLParagraphElement;
const clearRow = document.getElementById("clear-row") as HTMLDivElement;
const browserChoices = document.getElementById("browser-choices") as HTMLFieldSetElement;
const browserMessage = document.getElementById("browser-message") as HTMLParagraphElement;
const browserList = document.getElementById("browser-list") as HTMLDivElement;
const nameForm = document.getElementById("name-form") as HTMLFormElement;
const nameInput = document.getElementById("browser-name") as HTMLInputElement;
const nameMessage = document.getElementById("name-message") as HTMLParagraphElement;
const tabsChoices = document.getElementById("tabs-choices") as HTMLFieldSetElement;
const tabsMessage = document.getElementById("tabs-message") as HTMLParagraphElement;
const keepTabsInput = tabsChoices.querySelector<HTMLInputElement>("input[name=keep-tabs]")!;
const overlayChoices = document.getElementById("overlay-choices") as HTMLFieldSetElement;
const overlayMessage = document.getElementById("overlay-message") as HTMLParagraphElement;
const overlayInput = overlayChoices.querySelector<HTMLInputElement>("input[name=overlay]")!;

let portLoaded = false;
let pendingBrowser: RunBrowser | null = null;
let shownChoices = "";
let nameLoaded = false;
let pendingName: string | null = null;
let nameSavedAt = 0;

function savedLabel(browser: RunBrowser): string {
  return browser === HEADLESS ? "headless Chrome" : browserLabel(browser);
}

function choiceDescription(name: string, state: ExtensionState): string {
  if (name === HEADLESS) return "A hidden Chrome apart starts itself, signed out. Its runs still show in Activity.";
  if (!(state.browsers ?? []).includes(name)) return "Not connected right now. Runs wait for it, then fail if it does not connect.";
  if (name === state.browser) return "This browser. Signed in as you, in the pink apart group, so you can watch it work.";
  return "Signed in as you, in that browser.";
}

function renderBrowserChoices(state: ExtensionState): void {
  const names = Array.from(new Set([...(state.browsers ?? []), ...(state.defaultBrowser ? [state.defaultBrowser] : []), HEADLESS]));
  const key = JSON.stringify([names, state.browser, state.browsers]);
  if (key !== shownChoices) {
    shownChoices = key;
    browserList.innerHTML = names.map((name) => `<label class="choice"><input type="radio" name="browser" value="${escapeHtml(name)}"><span><strong>${escapeHtml(browserLabel(name))}</strong><span>${escapeHtml(choiceDescription(name, state))}</span><code>--browser ${escapeHtml(name)}</code></span></label>`).join("");
  }
}

function renderName(state: ExtensionState): void {
  if (!nameLoaded) {
    nameInput.value = state.browserName ?? "";
    nameLoaded = true;
  }
  const reconnected = (state.status?.at ?? 0) > nameSavedAt && connectionState(state) !== "disconnected";
  if (pendingName !== null && reconnected && state.browser && (!pendingName || state.browser === pendingName)) {
    nameMessage.className = "message ok";
    nameMessage.textContent = `Saved. Scripts reach this browser with --browser ${state.browser}.`;
    pendingName = null;
  }
}

nameForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const value = nameInput.value.trim().toLowerCase();
  if (value && (!isExtensionBrowserName(value))) {
    nameInput.setAttribute("aria-invalid", "true");
    nameMessage.className = "message error";
    nameMessage.textContent = value === HEADLESS ? "headless is taken by apart's own browser. Choose another name." : "Use up to 32 lowercase letters, digits and hyphens, starting with a letter or digit.";
    nameInput.focus();
    return;
  }
  nameInput.removeAttribute("aria-invalid");
  nameInput.value = value;
  pendingName = value;
  nameSavedAt = Date.now();
  nameMessage.className = "message";
  nameMessage.textContent = "Saving and reconnecting…";
  try {
    if (value) await chrome.storage.local.set({ browserName: value });
    else await chrome.storage.local.remove("browserName");
  } catch (error) {
    pendingName = null;
    nameMessage.className = "message error";
    nameMessage.textContent = `Could not save: ${error instanceof Error ? error.message : String(error)}`;
  }
});
let pendingTimer: number | undefined;

interface ToggleSetting {
  choices: HTMLFieldSetElement;
  input: HTMLInputElement;
  message: HTMLParagraphElement;
  read: (state: ExtensionState) => boolean | null;
  send: (value: boolean) => Record<string, unknown>;
  saved: (value: boolean) => string;
  command: string;
}

function bindToggle(setting: ToggleSetting): (state: ExtensionState) => void {
  let pending: boolean | null = null;
  let timer: number | undefined;
  const { choices, input, message } = setting;
  const fail = (text: string) => {
    pending = null;
    message.className = "message error";
    message.textContent = text;
    void render();
  };
  input.addEventListener("change", async () => {
    const value = input.checked;
    pending = value;
    message.className = "message";
    message.textContent = "Saving…";
    try {
      const response = await chrome.runtime.sendMessage(setting.send(value));
      if (!response?.ok) {
        fail("Could not save: apart is not connected. Check the connection above and try again.");
        return;
      }
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        if (pending === value) fail(`apart did not confirm the change. Try again, or run ${setting.command} in your terminal.`);
      }, 5000);
    } catch (error) {
      fail(`Could not save: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
  return (state) => {
    const live = connectionState(state) === "connected" || connectionState(state) === "running";
    const current = setting.read(state);
    if (pending !== null && current === pending) {
      window.clearTimeout(timer);
      message.className = "message ok";
      message.textContent = setting.saved(pending);
      pending = null;
    }
    if (pending !== null) return;
    choices.disabled = !live || current === null;
    input.checked = current === true;
    if (!live) {
      message.className = "message";
      message.textContent = `Connect apart to change this here, or run ${setting.command} in your terminal.`;
    } else if (current === null) {
      message.className = "message";
      message.textContent = "This apart version cannot change it from here. Update apart, then run apart daemon restart.";
    } else if (message.classList.contains("error") || !message.classList.contains("ok")) {
      message.className = "message";
      message.textContent = "";
    }
  };
}

const renderTabs = bindToggle({
  choices: tabsChoices,
  input: keepTabsInput,
  message: tabsMessage,
  read: (state) => state.keepTabs,
  send: (keep) => ({ type: "apart:set-keep-tabs", keep }),
  saved: (keep) => (keep ? "Saved. Tabs stay open when a script ends." : "Saved. Tabs close when a script ends."),
  command: "apart config keep-tabs on|off",
});

const renderOverlay = bindToggle({
  choices: overlayChoices,
  input: overlayInput,
  message: overlayMessage,
  read: (state) => state.overlay,
  send: (show) => ({ type: "apart:set-overlay", show }),
  saved: (show) => (show ? "Saved. From the next run, apart shows when it is working." : "Saved. From the next run, apart works without the glow, cursor or Take over button."),
  command: "apart config overlay on|off",
});

function renderBrowser(state: ExtensionState): void {
  const live = connectionState(state) === "connected" || connectionState(state) === "running";
  if (pendingBrowser && state.defaultBrowser === pendingBrowser) {
    window.clearTimeout(pendingTimer);
    browserMessage.className = "message ok";
    browserMessage.textContent = `Saved. Runs now use ${savedLabel(pendingBrowser)} unless they ask for another browser.`;
    pendingBrowser = null;
  }
  if (pendingBrowser) return;
  renderBrowserChoices(state);
  browserChoices.disabled = !live || state.defaultBrowser === null;
  browserChoices.querySelectorAll<HTMLInputElement>("input[name=browser]").forEach((input) => {
    input.checked = input.value === state.defaultBrowser;
  });
  if (!live) {
    browserMessage.className = "message";
    browserMessage.textContent = "Connect apart to change this here, or run apart config default-browser <name> in your terminal.";
  } else if (state.defaultBrowser === null) {
    browserMessage.className = "message";
    browserMessage.textContent = "This apart version cannot change it from here. Update apart, then run apart daemon restart.";
  } else if (browserMessage.classList.contains("error") || !browserMessage.classList.contains("ok")) {
    browserMessage.className = "message";
    browserMessage.textContent = "";
  }
}

browserChoices.addEventListener("change", async (event) => {
  const browser = (event.target as HTMLInputElement).value as RunBrowser;
  pendingBrowser = browser;
  browserMessage.className = "message";
  browserMessage.textContent = "Saving…";
  const fail = (text: string) => {
    pendingBrowser = null;
    browserMessage.className = "message error";
    browserMessage.textContent = text;
    void render();
  };
  try {
    const response = await chrome.runtime.sendMessage({ type: "apart:set-default-browser", browser });
    if (!response?.ok) {
      fail("Could not save: apart is not connected. Check the connection above and try again.");
      return;
    }
    window.clearTimeout(pendingTimer);
    pendingTimer = window.setTimeout(() => {
      if (pendingBrowser === browser) fail("apart did not confirm the change. Try again, or run apart config default-browser in your terminal.");
    }, 5000);
  } catch (error) {
    fail(`Could not save: ${error instanceof Error ? error.message : String(error)}`);
  }
});

async function render(): Promise<void> {
  try {
    const state = await readState();
    renderStatusCard(statusRoot, state);
    renderBrowser(state);
    renderTabs(state);
    renderOverlay(state);
    renderName(state);
    if (!portLoaded) {
      portInput.value = String(state.port ?? DEFAULT_PORT);
      portInput.disabled = false;
      saveButton.disabled = false;
      portLoaded = true;
    }
    if (!clearRow.dataset.confirming) {
      const button = clearRow.querySelector<HTMLButtonElement>("#clear");
      if (button) button.disabled = state.runs.length === 0;
      const clearMessage = document.getElementById("clear-message");
      if (clearMessage) clearMessage.textContent = state.runs.length === 0 ? "No history yet." : `${state.runs.length} run${state.runs.length === 1 ? "" : "s"} saved.`;
    }
  } catch (error) {
    statusRoot.innerHTML = `<div class="notice error"><strong>Could not read apart's data</strong>${escapeHtml(error instanceof Error ? error.message : String(error))}</div>`;
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const raw = portInput.value.trim();
  const port = Number(raw);
  if (!/^\d+$/.test(raw) || port < 1024 || port > 65535) {
    portInput.setAttribute("aria-invalid", "true");
    portMessage.className = "message error";
    portMessage.textContent = "Enter a whole number between 1024 and 65535.";
    portInput.focus();
    return;
  }
  portInput.removeAttribute("aria-invalid");
  saveButton.disabled = true;
  portMessage.className = "message";
  portMessage.textContent = "Saving…";
  try {
    await chrome.storage.local.set({ port });
    portMessage.className = "message ok";
    portMessage.textContent = port === DEFAULT_PORT
      ? "Saved. apart uses its usual port."
      : `Saved. Start the daemon on the same port: apart daemon restart --port ${port}`;
  } catch (error) {
    portMessage.className = "message error";
    portMessage.textContent = `Could not save: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    saveButton.disabled = false;
  }
});

function resetClearRow(): void {
  delete clearRow.dataset.confirming;
  clearRow.innerHTML = `<button class="button danger" type="button" id="clear">${icon("trash")}<span>Clear activity history</span></button><span class="message" id="clear-message" aria-live="polite"></span>`;
}

clearRow.addEventListener("click", async (event) => {
  const button = (event.target as HTMLElement).closest("button");
  if (!button) return;
  if (button.id === "clear") {
    const { runs } = await chrome.storage.local.get("runs");
    const count = Array.isArray(runs) ? runs.length : 0;
    clearRow.dataset.confirming = "1";
    clearRow.innerHTML = `<span class="message">Delete ${count} saved run${count === 1 ? "" : "s"}? This cannot be undone.</span>
      <button class="button danger" type="button" id="clear-confirm">Delete</button>
      <button class="button" type="button" id="clear-cancel">Cancel</button>`;
    clearRow.querySelector<HTMLButtonElement>("#clear-cancel")?.focus();
  } else if (button.id === "clear-cancel") {
    resetClearRow();
    await render();
    clearRow.querySelector<HTMLButtonElement>("#clear")?.focus();
  } else if (button.id === "clear-confirm") {
    await chrome.storage.local.set({ runs: [], historyClearedAt: Date.now() });
    resetClearRow();
    await render();
    const message = document.getElementById("clear-message");
    if (message) message.textContent = "History cleared.";
  }
});

resetClearRow();
bindStatusActions(statusRoot);
onStateChange(() => void render());
void render();
