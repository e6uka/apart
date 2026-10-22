export const HEADLESS = "headless";

const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;

const LABELS: Record<string, string> = {
  chrome: "Chrome",
  "chrome-beta": "Chrome Beta",
  "chrome-canary": "Chrome Canary",
  "chrome-for-testing": "Chrome for Testing",
  chromium: "Chromium",
  arc: "Arc",
  dia: "Dia",
  brave: "Brave",
  edge: "Edge",
  vivaldi: "Vivaldi",
  opera: "Opera",
  headless: "Headless",
};

const PROCESS_NAMES: [RegExp, string][] = [
  [/chrome for testing/i, "chrome-for-testing"],
  [/chrome canary/i, "chrome-canary"],
  [/chrome beta/i, "chrome-beta"],
  [/\/dia\.app\/|^dia\b/i, "dia"],
  [/\/arc\.app\/|^arc\b/i, "arc"],
  [/brave/i, "brave"],
  [/microsoft edge|msedge/i, "edge"],
  [/vivaldi/i, "vivaldi"],
  [/opera/i, "opera"],
  [/chromium/i, "chromium"],
  [/google chrome|\/chrome$|^chrome\b/i, "chrome"],
];

const BRAND_NAMES: [RegExp, string][] = [
  [/microsoft edge/i, "edge"],
  [/brave/i, "brave"],
  [/opera/i, "opera"],
  [/vivaldi/i, "vivaldi"],
  [/^dia$/i, "dia"],
  [/^arc$/i, "arc"],
  [/google chrome/i, "chrome"],
  [/chromium/i, "chromium"],
];

export function isBrowserName(value: unknown): value is string {
  return typeof value === "string" && NAME_PATTERN.test(value);
}

export function isExtensionBrowserName(value: unknown): value is string {
  return isBrowserName(value) && value !== HEADLESS;
}

export function browserLabel(name: string): string {
  return LABELS[name] ?? name.split("-").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
}

export function nameFromProcess(command: string): string | null {
  for (const [pattern, name] of PROCESS_NAMES) if (pattern.test(command)) return name;
  return null;
}

export function nameFromBrands(brands: readonly string[] | undefined): string {
  for (const [pattern, name] of BRAND_NAMES) if ((brands ?? []).some((brand) => pattern.test(brand))) return name;
  return "chrome";
}
