import { bindStatusActions, browserLabel, escapeHtml, icon, onStateChange, readState, relativeTime, renderStatusCard, resultBadge, duration, runBrowser, runTitle } from "./ui/common";

const statusRoot = document.getElementById("status") as HTMLElement;
const recentRoot = document.getElementById("recent") as HTMLElement;

document.querySelectorAll<HTMLElement>("[data-icon]").forEach((el) => {
  el.innerHTML = icon(el.dataset.icon as Parameters<typeof icon>[0]);
});

async function render(): Promise<void> {
  try {
    const state = await readState();
    renderStatusCard(statusRoot, state, { compact: true });
    recentRoot.removeAttribute("aria-busy");
    if (state.runs.length === 0) {
      recentRoot.innerHTML = `<p class="recent-empty">Nothing has run yet. Scripts you run with <code>apart repl</code> show up here.</p>`;
      return;
    }
    recentRoot.innerHTML = state.runs.slice(0, 3).map((run) => `
      <div class="recent-row">
        <div class="line"><span class="page" title="${escapeHtml(run.urls.join("\n"))}">${escapeHtml(runTitle(run))}</span>${resultBadge(run)}</div>
        <div class="meta"><span>${escapeHtml(relativeTime(run.startedAt + run.elapsedMs))}</span><span>took ${escapeHtml(duration(run.elapsedMs))}</span>${runBrowser(run) !== (state.browser ?? "chrome") ? `<span>${escapeHtml(browserLabel(runBrowser(run)))}</span>` : ""}</div>
        ${run.ok || !run.error ? "" : `<p class="error" title="${escapeHtml(run.error)}">${escapeHtml(run.error)}</p>`}
      </div>`).join("");
  } catch (error) {
    recentRoot.removeAttribute("aria-busy");
    statusRoot.dataset.state = "disconnected";
    recentRoot.innerHTML = `<div class="notice error"><strong>Could not read apart's data</strong>${escapeHtml(error instanceof Error ? error.message : String(error))}</div>`;
  }
}

bindStatusActions(statusRoot);
onStateChange(() => void render());
void render();
