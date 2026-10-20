import { computeAccessibleName } from "dom-accessibility-api";

type SnapshotOptions = { interactive?: boolean; maxTextLength?: number; maxEntries?: number };
type FindKind = "css" | "ref" | "role" | "label" | "text" | "placeholder";
type TextMatcher = string | { regex: string; flags: string } | null | undefined;
type FindArg = { selector?: string; ref?: string; role?: string; name?: TextMatcher; text?: TextMatcher; exact?: boolean };
type TreeNode = { line: string | null; keep: boolean; children: TreeNode[] };
type Entry = { ref: string; role: string; name: string; element: Element };

const INTERACTIVE_ROLES = new Set([
  "link", "button", "textbox", "searchbox", "checkbox", "radio", "combobox", "listbox", "option",
  "menuitem", "menuitemcheckbox", "menuitemradio", "slider", "spinbutton", "switch", "tab", "treeitem",
]);
const LEAF_ROLES = new Set([
  "button", "link", "textbox", "searchbox", "checkbox", "radio", "combobox", "option", "menuitem",
  "menuitemcheckbox", "menuitemradio", "tab", "heading", "img", "slider", "switch", "spinbutton", "progressbar",
]);
const SKIP_TAGS = new Set(["script", "style", "noscript", "template", "head", "meta", "link", "title", "iframe", "object", "embed"]);
const INPUT_ROLES: Record<string, string> = {
  button: "button", submit: "button", reset: "button", image: "button", file: "button", color: "button",
  checkbox: "checkbox", radio: "radio", range: "slider", number: "spinbutton", search: "searchbox",
};
const TAG_ROLES: Record<string, string> = {
  a: "link", area: "link", button: "button", textarea: "textbox", h1: "heading", h2: "heading", h3: "heading",
  h4: "heading", h5: "heading", h6: "heading", nav: "navigation", main: "main", header: "banner",
  footer: "contentinfo", aside: "complementary", form: "form", article: "article", ul: "list", ol: "list",
  li: "listitem", table: "table", tr: "row", td: "cell", th: "columnheader", img: "img", dialog: "dialog",
  details: "group", summary: "button", option: "option", hr: "separator", fieldset: "group", figure: "figure",
  output: "status", progress: "progressbar", meter: "meter", p: "paragraph", blockquote: "blockquote", code: "code",
};
const ANNOTATION_ID = "__apart_annotations__";

let entries: Entry[] = [];
const refs = new Map<string, Element>();

function isVisible(el: Element): boolean {
  if (el.getAttribute("aria-hidden") === "true") return false;
  const style = getComputedStyle(el);
  if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse") return false;
  if (style.opacity === "0" && !INTERACTIVE_ROLES.has(roleOf(el) ?? "")) return false;
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) {
    return el.tagName.toLowerCase() === "option" || (el.childNodes.length > 0 && style.overflow !== "hidden");
  }
  return true;
}

function roleOf(el: Element): string | null {
  const explicit = el.getAttribute("role")?.trim().split(/\s+/)[0];
  if (explicit) return explicit === "presentation" || explicit === "none" ? null : explicit;
  const tag = el.tagName.toLowerCase();
  if (tag === "input") {
    const input = el as HTMLInputElement;
    const type = (input.getAttribute("type") || "text").toLowerCase();
    if (type === "hidden") return null;
    if (input.list && ["text", "search", "url", "tel", "email"].includes(type)) return "combobox";
    return INPUT_ROLES[type] ?? "textbox";
  }
  if (tag === "select") {
    const select = el as HTMLSelectElement;
    return select.multiple || select.size > 1 ? "listbox" : "combobox";
  }
  if (tag === "a" && !el.hasAttribute("href")) return null;
  if (tag === "section") return el.hasAttribute("aria-label") || el.hasAttribute("aria-labelledby") ? "region" : null;
  if (tag === "img" && el.getAttribute("alt") === "") return null;
  if (tag === "svg") return el.querySelector("title") || el.hasAttribute("aria-label") ? "img" : null;
  if (el.hasAttribute("contenteditable") && el.getAttribute("contenteditable") !== "false") return "textbox";
  const role = TAG_ROLES[tag] ?? null;
  if (role === null && el.hasAttribute("tabindex") && Number(el.getAttribute("tabindex")) >= 0) return "generic";
  return role;
}

function nameOf(el: Element): string {
  let name = "";
  try {
    name = computeAccessibleName(el, { computedStyleSupportsPseudoElements: false });
  } catch {
    name = el.getAttribute("aria-label") ?? "";
  }
  if (!name) name = el.getAttribute("placeholder") ?? el.getAttribute("title") ?? "";
  return name.replace(/\s+/g, " ").trim();
}

function quote(text: string): string {
  return JSON.stringify(text);
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function attrsOf(el: Element, role: string): string[] {
  const attrs: string[] = [];
  const tag = el.tagName.toLowerCase();
  if (role === "heading") {
    const level = el.getAttribute("aria-level") ?? (tag.match(/^h([1-6])$/)?.[1] ?? "2");
    attrs.push(`level=${level}`);
  }
  const ariaChecked = el.getAttribute("aria-checked");
  if (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio")) {
    attrs.push(el.indeterminate ? "checked=mixed" : el.checked ? "checked" : "unchecked");
  } else if (ariaChecked) {
    attrs.push(ariaChecked === "true" ? "checked" : ariaChecked === "mixed" ? "checked=mixed" : "unchecked");
  }
  const pressed = el.getAttribute("aria-pressed");
  if (pressed === "true") attrs.push("pressed");
  const expanded = el.getAttribute("aria-expanded");
  if (expanded) attrs.push(expanded === "true" ? "expanded" : "collapsed");
  const selected = el.getAttribute("aria-selected");
  if (selected === "true" || (el instanceof HTMLOptionElement && el.selected)) attrs.push("selected");
  if ((el as HTMLButtonElement).disabled === true || el.getAttribute("aria-disabled") === "true") attrs.push("disabled");
  if ((el as HTMLInputElement).required === true || el.getAttribute("aria-required") === "true") attrs.push("required");
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    if (el instanceof HTMLInputElement && el.type === "password") {
      if (el.value) attrs.push("value=•••");
    } else if (el.value && !["checkbox", "radio", "button", "submit", "reset", "file"].includes((el as HTMLInputElement).type)) {
      attrs.push(`value=${quote(truncate(el.value, 60))}`);
    }
  } else if (el instanceof HTMLSelectElement) {
    const option = el.selectedOptions[0];
    if (option) attrs.push(`value=${quote(truncate(option.label || option.value, 60))}`);
  }
  if (tag === "a" && el.hasAttribute("href")) {
    attrs.push(`url=${quote(truncate((el as HTMLAnchorElement).href, 120))}`);
  }
  return attrs;
}

function childNodesOf(el: Element): Node[] {
  const nodes: Node[] = [];
  if (el.shadowRoot) nodes.push(...Array.from(el.shadowRoot.childNodes));
  nodes.push(...Array.from(el.childNodes));
  return nodes;
}

function build(node: Node, opts: Required<SnapshotOptions>, state: { count: number; refCounter: number; truncated: boolean }): TreeNode[] {
  if (state.truncated) return [];
  if (node.nodeType === Node.TEXT_NODE) {
    const text = (node.textContent ?? "").replace(/\s+/g, " ").trim();
    if (!text) return [];
    return [{ line: `text: ${quote(truncate(text, opts.maxTextLength))}`, keep: false, children: [] }];
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return [];
  const el = node as Element;
  const tag = el.tagName.toLowerCase();
  if (SKIP_TAGS.has(tag)) return [];
  if (!isVisible(el)) return [];
  const role = roleOf(el);
  if (role === null) {
    return childNodesOf(el).flatMap((child) => build(child, opts, state));
  }
  if (state.count >= opts.maxEntries) {
    state.truncated = true;
    return [{ line: "… (snapshot truncated)", keep: true, children: [] }];
  }
  state.count += 1;
  const interactive = INTERACTIVE_ROLES.has(role) || role === "generic";
  const name = role === "generic" ? "" : nameOf(el);
  let ref: string | null = null;
  if (interactive) {
    ref = `e${++state.refCounter}`;
    refs.set(ref, el);
    entries.push({ ref, role, name, element: el });
  }
  const parts = [role === "generic" ? "generic" : role];
  if (name) parts.push(quote(truncate(name, opts.maxTextLength)));
  const attrs = attrsOf(el, role);
  if (attrs.length) parts.push(`[${attrs.join("] [")}]`);
  if (ref) parts.push(`[ref=${ref}]`);
  const children = LEAF_ROLES.has(role) || (interactive && role !== "generic" && role !== "listbox" && role !== "combobox")
    ? []
    : childNodesOf(el).flatMap((child) => build(child, opts, state));
  if (role === "combobox" && el instanceof HTMLSelectElement) {
    for (const option of Array.from(el.options).slice(0, 50)) {
      children.push({ line: `option ${quote(truncate(option.label || option.value, opts.maxTextLength))}${option.selected ? " [selected]" : ""}`, keep: false, children: [] });
    }
  }
  const keep = interactive || role === "heading" || children.some((child) => child.keep);
  return [{ line: parts.join(" "), keep, children }];
}

function serialize(nodes: TreeNode[], opts: Required<SnapshotOptions>, depth: number, out: string[]): void {
  for (const node of nodes) {
    if (opts.interactive && !node.keep) continue;
    if (node.line === null) {
      serialize(node.children, opts, depth, out);
      continue;
    }
    const children = opts.interactive ? node.children.filter((child) => child.keep) : node.children;
    out.push(`${"  ".repeat(depth)}- ${node.line}${children.length ? ":" : ""}`);
    serialize(children, opts, depth + 1, out);
  }
}

function snapshot(options: SnapshotOptions = {}): { tree: string; fullTree: string; refCount: number } {
  const full: Required<SnapshotOptions> = {
    interactive: false,
    maxTextLength: options.maxTextLength ?? 200,
    maxEntries: options.maxEntries ?? 1500,
  };
  entries = [];
  refs.clear();
  const state = { count: 0, refCounter: 0, truncated: false };
  const nodes = build(document.documentElement, full, state);
  const fullOut: string[] = [];
  serialize(nodes, full, 0, fullOut);
  const fullTree = fullOut.join("\n");
  if (!options.interactive) return { tree: fullTree, fullTree, refCount: state.refCounter };
  const out: string[] = [];
  serialize(nodes, { ...full, interactive: true }, 0, out);
  return { tree: out.join("\n"), fullTree, refCount: state.refCounter };
}

function* walk(root: ParentNode = document): Generator<Element> {
  const all = root.querySelectorAll("*");
  for (const el of Array.from(all)) {
    yield el;
    if (el.shadowRoot) yield* walk(el.shadowRoot);
  }
}

function matches(actual: string, expected: TextMatcher, exact: boolean | undefined): boolean {
  if (expected === null || expected === undefined) return true;
  const a = actual.replace(/\s+/g, " ").trim();
  if (typeof expected === "object") return new RegExp(expected.regex, expected.flags).test(a);
  const e = expected.replace(/\s+/g, " ").trim();
  return exact ? a === e : a.toLowerCase().includes(e.toLowerCase());
}

function candidates(kind: FindKind, arg: FindArg): Element[] {
  switch (kind) {
    case "ref": {
      const el = refs.get(arg.ref ?? "");
      return el && el.isConnected ? [el] : [];
    }
    case "css": {
      const selector = (arg.selector ?? "").trim();
      const refMatch = selector.match(/^\[ref=([^\]]+)\]$/) ?? selector.match(/^(f\d+)?(e\d+)$/);
      if (refMatch) return candidates("ref", { ref: refMatch[refMatch.length - 1] });
      return Array.from(document.querySelectorAll(selector));
    }
    case "role": {
      const found: Element[] = [];
      for (const el of walk()) {
        if (roleOf(el) !== arg.role || !isVisible(el)) continue;
        if (matches(nameOf(el), arg.name, arg.exact)) found.push(el);
      }
      return found;
    }
    case "label": {
      const found: Element[] = [];
      for (const el of walk()) {
        const role = roleOf(el);
        if (!role || !INTERACTIVE_ROLES.has(role) || !isVisible(el)) continue;
        if (matches(nameOf(el), arg.text, arg.exact)) found.push(el);
      }
      return found;
    }
    case "placeholder": {
      return Array.from(walk()).filter((el) => matches(el.getAttribute("placeholder") ?? "", arg.text, arg.exact));
    }
    case "text": {
      const all = Array.from(walk()).filter((el) => {
        if (SKIP_TAGS.has(el.tagName.toLowerCase()) || !isVisible(el)) return false;
        return matches((el as HTMLElement).innerText ?? el.textContent ?? "", arg.text, arg.exact);
      });
      return all.filter((el) => !all.some((other) => other !== el && el.contains(other)));
    }
  }
}

function find(kind: FindKind, arg: FindArg, nth: number): Element | null {
  const list = candidates(kind, arg);
  const index = nth < 0 ? list.length + nth : nth;
  return list[index] ?? null;
}

function countOf(kind: FindKind, arg: FindArg): number {
  return candidates(kind, arg).length;
}

function describe(el: Element): string {
  const role = roleOf(el);
  const name = role ? nameOf(el) : "";
  return `${el.tagName.toLowerCase()}${role ? ` role=${role}` : ""}${name ? ` "${truncate(name, 60)}"` : ""}`;
}

function annotate(): number {
  unannotate();
  const container = document.createElement("div");
  container.id = ANNOTATION_ID;
  container.style.cssText = "position:absolute;left:0;top:0;width:0;height:0;overflow:visible;pointer-events:none;z-index:2147483647;";
  let drawn = 0;
  const rects = entries.map((entry) => entry.element.getBoundingClientRect());
  const overlaps = (a: { left: number; top: number; right: number; bottom: number }, b: DOMRect) =>
    a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
  entries.forEach((entry, index) => {
    const rect = rects[index];
    if (rect.width === 0 && rect.height === 0) return;
    const box = document.createElement("div");
    box.style.cssText = `position:absolute;left:${rect.left + scrollX}px;top:${rect.top + scrollY}px;width:${rect.width}px;height:${rect.height}px;outline:2px solid #e11d48;outline-offset:-1px;`;
    const label = document.createElement("span");
    label.textContent = entry.ref;
    const above = { left: rect.left, top: rect.top - 14, right: rect.left + entry.ref.length * 7 + 8, bottom: rect.top };
    const blocked = above.top < 0 || rects.some((other, j) => j !== index && overlaps(above, other));
    const placement = blocked ? "top:0;border-radius:0 0 3px 0;" : "top:-14px;border-radius:3px 3px 0 0;";
    label.style.cssText = `position:absolute;left:0;${placement}background:#e11d48;color:#fff;font:bold 10px/14px ui-monospace,monospace;padding:0 3px;white-space:nowrap;`;
    box.appendChild(label);
    container.appendChild(box);
    drawn += 1;
  });
  document.documentElement.appendChild(container);
  return drawn;
}

function unannotate(): void {
  document.getElementById(ANNOTATION_ID)?.remove();
}

const api = { snapshot, find, countOf, visible: isVisible, describe, annotate, unannotate, refCount: () => refs.size };

(globalThis as unknown as { __apart: typeof api }).__apart = api;

export type ApartApi = typeof api;
