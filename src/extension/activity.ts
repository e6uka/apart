import type { RunRecord } from "../shared/protocol";
import { absoluteTime, displayUrl, duration, escapeHtml, icon, onStateChange, readState, relativeTime, resultBadge, resultLabel } from "./ui/common";

type Result = "ok" | "failed";
type Range = "any" | "1h" | "24h" | "7d";
type Sort = "newest" | "oldest" | "slowest";
interface Query { q: string; result: Result[]; range: Range; sort: Sort; page: number }

const PAGE_SIZE = 25;
const RESULTS: Result[] = ["ok", "failed"];
const RANGES: Record<Range, { label: string; ms: number }> = {
  any: { label: "Any time", ms: Infinity },
  "1h": { label: "Last hour", ms: 3600e3 },
  "24h": { label: "Last 24 hours", ms: 86400e3 },
  "7d": { label: "Last 7 days", ms: 7 * 86400e3 },
};
const SORTS: Record<Sort, string> = { newest: "Newest first", oldest: "Oldest first", slowest: "Slowest first" };
const RESULT_LABELS: Record<Result, string> = { ok: "Done", failed: "Failed" };

const search = document.getElementById("search") as HTMLInputElement;
const filtersButton = document.getElementById("filters-button") as HTMLButtonElement;
const filterCount = document.getElementById("filter-count") as HTMLSpanElement;
const popover = document.getElementById("filters") as HTMLDivElement;
const chips = document.getElementById("chips") as HTMLDivElement;
const listMeta = document.getElementById("list-meta") as HTMLParagraphElement;
const list = document.getElementById("list") as HTMLDivElement;
const pager = document.getElementById("pager") as HTMLElement;

document.querySelectorAll<HTMLElement>("[data-icon]").forEach((el) => {
  el.outerHTML = icon(el.dataset.icon as Parameters<typeof icon>[0]);
});

function readQuery(): Query {
  const params = new URLSearchParams(location.search);
  const result = (params.get("result") ?? "").split(",").filter((value): value is Result => RESULTS.includes(value as Result));
  const range = (params.get("range") ?? "any") as Range;
  const sort = (params.get("sort") ?? "newest") as Sort;
  const page = Number(params.get("page") ?? "1");
  return {
    q: (params.get("q") ?? "").trim(),
    result: Array.from(new Set(result)),
    range: range in RANGES ? range : "any",
    sort: sort in SORTS ? sort : "newest",
    page: Number.isInteger(page) && page >= 1 ? page : 1,
  };
}

function writeQuery(query: Query): void {
  const params = new URLSearchParams();
  if (query.q) params.set("q", query.q);
  if (query.result.length) params.set("result", query.result.join(","));
  if (query.range !== "any") params.set("range", query.range);
  if (query.sort !== "newest") params.set("sort", query.sort);
  if (query.page > 1) params.set("page", String(query.page));
  const next = `${location.pathname}${params.toString() ? `?${params}` : ""}`;
  if (next !== `${location.pathname}${location.search}`) history.replaceState(null, "", next);
}

let query = readQuery();
let runs: RunRecord[] = [];
let loadState: "loading" | "ready" | "error" = "loading";
let loadError = "";

function haystack(run: RunRecord): string {
  return [
    resultLabel(run),
    run.ok ? "ok succeeded success" : "failed error",
    ...run.urls,
    ...run.urls.map(displayUrl),
    run.error ?? "",
    absoluteTime(run.startedAt),
    relativeTime(run.startedAt),
    duration(run.elapsedMs),
    run.urls.length === 0 ? "No pages opened" : "",
  ].join("\n").toLowerCase();
}

function filtered(now = Date.now()): RunRecord[] {
  const needle = query.q.toLowerCase();
  const windowMs = RANGES[query.range].ms;
  const matches = runs.filter((run) =>
    (query.result.length === 0 || query.result.includes(run.ok ? "ok" : "failed"))
    && (windowMs === Infinity || now - run.startedAt <= windowMs)
    && (!needle || haystack(run).includes(needle)));
  const tie = (a: RunRecord, b: RunRecord) => a.id.localeCompare(b.id);
  if (query.sort === "oldest") return matches.sort((a, b) => a.startedAt - b.startedAt || tie(a, b));
  if (query.sort === "slowest") return matches.sort((a, b) => b.elapsedMs - a.elapsedMs || tie(a, b));
  return matches.sort((a, b) => b.startedAt - a.startedAt || tie(a, b));
}

function activeFilterCount(): number {
  return query.result.length + (query.range !== "any" ? 1 : 0) + (query.sort !== "newest" ? 1 : 0);
}

function syncControls(): void {
  if (document.activeElement !== search) search.value = query.q;
  popover.querySelectorAll<HTMLInputElement>("input[name=result]").forEach((input) => { input.checked = query.result.includes(input.value as Result); });
  popover.querySelectorAll<HTMLInputElement>("input[name=range]").forEach((input) => { input.checked = input.value === query.range; });
  popover.querySelectorAll<HTMLInputElement>("input[name=sort]").forEach((input) => { input.checked = input.value === query.sort; });
  const count = activeFilterCount();
  filterCount.hidden = count === 0;
  filterCount.textContent = String(count);
  filtersButton.setAttribute("aria-label", count ? `Filters, ${count} on` : "Filters");
}

function renderChips(): void {
  const items: string[] = [];
  if (query.q) items.push(`<button class="chip" type="button" data-remove="q" aria-label="Remove search ${escapeHtml(query.q)}">Search: ${escapeHtml(query.q)}${icon("x")}</button>`);
  for (const result of query.result) items.push(`<button class="chip" type="button" data-remove="result" data-value="${result}" aria-label="Remove filter ${RESULT_LABELS[result]}">${RESULT_LABELS[result]}${icon("x")}</button>`);
  if (query.range !== "any") items.push(`<button class="chip" type="button" data-remove="range" aria-label="Remove filter ${RANGES[query.range].label}">${RANGES[query.range].label}${icon("x")}</button>`);
  if (query.sort !== "newest") items.push(`<button class="chip" type="button" data-remove="sort" aria-label="Remove sort ${SORTS[query.sort]}">${SORTS[query.sort]}${icon("x")}</button>`);
  chips.hidden = items.length === 0;
  chips.innerHTML = items.length ? `${items.join("")}<button class="clear-all" type="button" data-remove="all">Clear all</button>` : "";
}

function renderRun(run: RunRecord): string {
  const pages = run.urls.length ? escapeHtml(displayUrl(run.urls[0])) : "No pages opened";
  const more = run.urls.length > 1
    ? `<ul class="run-more">${run.urls.slice(1).map((url) => `<li>${escapeHtml(displayUrl(url))}</li>`).join("")}</ul>`
    : "";
  return `<li>
    <div class="run-line"><span class="run-pages">${pages}</span>${resultBadge(run)}</div>
    ${more}
    <div class="run-meta">
      <span><time datetime="${new Date(run.startedAt).toISOString()}" title="${escapeHtml(absoluteTime(run.startedAt))}">${escapeHtml(absoluteTime(run.startedAt))}</time></span>
      <span>took ${escapeHtml(duration(run.elapsedMs))}</span>
      <span>${run.tabsOpened} tab${run.tabsOpened === 1 ? "" : "s"} opened</span>
    </div>
    ${run.ok || !run.error ? "" : `<p class="run-error">${escapeHtml(run.error)}</p>`}
  </li>`;
}

function renderList(): void {
  if (loadState === "loading") return;
  list.removeAttribute("aria-busy");
  if (loadState === "error") {
    listMeta.textContent = "";
    pager.hidden = true;
    list.innerHTML = `<div class="state-box"><strong>Could not load activity</strong><p>${escapeHtml(loadError)}</p><button class="button" type="button" data-retry>${icon("refresh")}<span>Try again</span></button></div>`;
    return;
  }
  if (runs.length === 0) {
    listMeta.textContent = "";
    pager.hidden = true;
    list.innerHTML = `<div class="state-box"><strong>No runs yet</strong><p>Scripts you run from your terminal with <code>apart repl</code>, or through gstack's /browse, appear here.</p></div>`;
    return;
  }
  const matches = filtered();
  const pages = Math.max(1, Math.ceil(matches.length / PAGE_SIZE));
  if (query.page > pages) {
    query.page = pages;
    writeQuery(query);
  }
  if (matches.length === 0) {
    listMeta.textContent = `0 of ${runs.length} runs`;
    pager.hidden = true;
    list.innerHTML = `<div class="state-box"><strong>Nothing matches</strong><p>No run fits this search and these filters.</p><button class="button" type="button" data-remove="all">Clear all</button></div>`;
    return;
  }
  const start = (query.page - 1) * PAGE_SIZE;
  const slice = matches.slice(start, start + PAGE_SIZE);
  const filteredNote = matches.length === runs.length ? `${runs.length} run${runs.length === 1 ? "" : "s"}` : `${matches.length} of ${runs.length} runs`;
  listMeta.textContent = pages > 1 ? `${filteredNote}, showing ${start + 1} to ${start + slice.length}` : filteredNote;
  list.innerHTML = `<ul class="runs">${slice.map(renderRun).join("")}</ul>`;
  pager.hidden = pages <= 1;
  if (pages > 1) {
    pager.innerHTML = `
      <button class="button" type="button" data-page="${query.page - 1}" ${query.page <= 1 ? "disabled" : ""}>${icon("chevronLeft")}<span>Newer</span></button>
      <span>Page ${query.page} of ${pages}</span>
      <button class="button" type="button" data-page="${query.page + 1}" ${query.page >= pages ? "disabled" : ""}><span>Older</span>${icon("chevronRight")}</button>`;
  }
}

function update(change: Partial<Query>, options: { resetPage?: boolean } = { resetPage: true }): void {
  query = { ...query, ...change, ...(options.resetPage ? { page: 1 } : {}) };
  syncControls();
  renderChips();
  queueMicrotask(() => {
    writeQuery(query);
    renderList();
  });
}

let searchTimer: number | undefined;
search.addEventListener("input", () => {
  window.clearTimeout(searchTimer);
  searchTimer = window.setTimeout(() => update({ q: search.value.trim() }), 300);
});
search.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    window.clearTimeout(searchTimer);
    update({ q: search.value.trim() });
  }
});

function openPopover(): void {
  popover.hidden = false;
  filtersButton.setAttribute("aria-expanded", "true");
  popover.querySelector<HTMLInputElement>("input")?.focus();
}

function closePopover(returnFocus = true): void {
  if (popover.hidden) return;
  popover.hidden = true;
  filtersButton.setAttribute("aria-expanded", "false");
  if (returnFocus) filtersButton.focus();
}

filtersButton.addEventListener("click", () => (popover.hidden ? openPopover() : closePopover()));
popover.addEventListener("change", (event) => {
  const input = event.target as HTMLInputElement;
  if (input.name === "result") {
    const result = Array.from(popover.querySelectorAll<HTMLInputElement>("input[name=result]:checked")).map((el) => el.value as Result);
    update({ result });
  } else if (input.name === "range") update({ range: input.value as Range });
  else if (input.name === "sort") update({ sort: input.value as Sort });
});
document.getElementById("filters-done")!.addEventListener("click", () => closePopover());
document.getElementById("filters-reset")!.addEventListener("click", () => update({ result: [], range: "any", sort: "newest" }));
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !popover.hidden) {
    event.preventDefault();
    closePopover();
  }
});
document.addEventListener("pointerdown", (event) => {
  if (popover.hidden) return;
  const target = event.target as Node;
  if (!popover.contains(target) && !filtersButton.contains(target)) closePopover(false);
});

document.addEventListener("click", (event) => {
  const target = (event.target as HTMLElement).closest<HTMLElement>("[data-remove], [data-page], [data-retry]");
  if (!target) return;
  if (target.dataset.retry !== undefined) {
    void load();
    return;
  }
  if (target.dataset.page) {
    update({ page: Number(target.dataset.page) }, { resetPage: false });
    document.querySelector("h1")?.scrollIntoView({ block: "start" });
    return;
  }
  switch (target.dataset.remove) {
    case "q":
      search.value = "";
      update({ q: "" });
      break;
    case "result":
      update({ result: query.result.filter((value) => value !== target.dataset.value) });
      break;
    case "range":
      update({ range: "any" });
      break;
    case "sort":
      update({ sort: "newest" });
      break;
    case "all":
      search.value = "";
      update({ q: "", result: [], range: "any", sort: "newest" });
      search.focus();
      break;
  }
});

async function load(): Promise<void> {
  try {
    runs = (await readState()).runs;
    loadState = "ready";
  } catch (error) {
    loadState = "error";
    loadError = error instanceof Error ? error.message : String(error);
  }
  renderList();
}

window.addEventListener("popstate", () => {
  query = readQuery();
  syncControls();
  renderChips();
  renderList();
});

syncControls();
renderChips();
onStateChange(() => void load());
void load();
