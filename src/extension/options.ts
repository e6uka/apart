import { DEFAULT_PORT } from "../shared/protocol";
import { bindStatusActions, escapeHtml, icon, onStateChange, readState, renderStatusCard } from "./ui/common";

const statusRoot = document.getElementById("status") as HTMLElement;
const form = document.getElementById("port-form") as HTMLFormElement;
const portInput = document.getElementById("port") as HTMLInputElement;
const saveButton = form.querySelector<HTMLButtonElement>("button[type=submit]")!;
const portMessage = document.getElementById("port-message") as HTMLParagraphElement;
const clearRow = document.getElementById("clear-row") as HTMLDivElement;

let portLoaded = false;

async function render(): Promise<void> {
  try {
    const state = await readState();
    renderStatusCard(statusRoot, state);
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
    await chrome.storage.local.set({ runs: [] });
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
