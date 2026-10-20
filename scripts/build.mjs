import { build, context } from "esbuild";
import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const watch = process.argv.includes("--watch");
const store = process.argv.includes("--store");
const pkg = JSON.parse(readFileSync("package.json", "utf8"));

const targets = [
  {
    entryPoints: ["src/injected/snapshot.ts"],
    outfile: "dist/injected/snapshot.js",
    format: "iife",
    platform: "browser",
    target: "chrome120",
    minify: true,
  },
  {
    entryPoints: ["src/cli/main.ts"],
    outfile: "dist/apart.js",
    format: "esm",
    platform: "node",
    target: "node22",
    packages: "external",
    banner: { js: "#!/usr/bin/env node" },
    define: { __APART_VERSION__: JSON.stringify(pkg.version) },
  },
  {
    entryPoints: ["src/extension/background.ts"],
    outfile: "dist/extension/background.js",
    format: "esm",
    platform: "browser",
    target: "chrome120",
  },
  ...["options", "popup", "activity"].map((name) => ({
    entryPoints: [`src/extension/${name}.ts`],
    outfile: `dist/extension/${name}.js`,
    format: "iife",
    platform: "browser",
    target: "chrome120",
    loader: { ".svg": "text" },
  })),
].map((options) => ({ bundle: true, logLevel: "info", ...options }));

const STATIC_FILES = ["manifest.json", "options.html", "popup.html", "activity.html", "popup.css", "page.css"];
const FONT_WEIGHTS = [400, 600, 700];

function copyStatic() {
  mkdirSync("dist/extension/fonts", { recursive: true });
  for (const file of STATIC_FILES) cpSync(`src/extension/${file}`, `dist/extension/${file}`);
  cpSync("src/extension/ui/theme.css", "dist/extension/theme.css");
  cpSync("src/extension/icons", "dist/extension/icons", { recursive: true });
  for (const weight of FONT_WEIGHTS) {
    cpSync(`node_modules/@fontsource/figtree/files/figtree-latin-${weight}-normal.woff2`, `dist/extension/fonts/figtree-${weight}.woff2`);
  }
  cpSync("node_modules/@fontsource/figtree/LICENSE", "dist/extension/fonts/LICENSE-Figtree.txt");
  chmodSync("dist/apart.js", 0o755);
}

if (watch) {
  const contexts = await Promise.all(targets.map((options) => context(options)));
  await Promise.all(contexts.map((ctx) => ctx.watch()));
  copyStatic();
  console.log("watching…");
} else {
  await Promise.all(targets.map((options) => build(options)));
  copyStatic();
  if (store) packageForStore();
}

function packageForStore() {
  const dir = "dist/store/extension";
  const zip = `dist/store/apart-extension-${pkg.version}.zip`;
  rmSync("dist/store", { recursive: true, force: true });
  mkdirSync("dist/store", { recursive: true });
  cpSync("dist/extension", dir, { recursive: true });
  const manifest = JSON.parse(readFileSync(`${dir}/manifest.json`, "utf8"));
  delete manifest.key;
  manifest.version = pkg.version;
  writeFileSync(`${dir}/manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`);
  execFileSync("zip", ["-q", "-r", "-X", `../${zip.split("/").pop()}`, "."], { cwd: dir });
  if (!existsSync(zip)) throw new Error(`zip was not created at ${zip}`);
  console.log(`store package: ${zip} (manifest without "key"; the Web Store assigns the extension id)`);
}
