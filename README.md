<picture>
  <source media="(prefers-color-scheme: dark)" srcset="design/brand/header-dark.svg">
  <img alt="apart: your real browser, for your terminal agent" src="design/brand/header-light.svg" width="100%">
</picture>

Drive your real, signed-in Chrome from the terminal.

`apart repl` runs a Playwright-style script against tabs it opens in **your own Chrome**, with your cookies and logged-in sessions, and prints what it saw. It is a plain command line tool: call it yourself, from a shell script, or from any coding agent that can run terminal commands (Claude Code, Codex, Cursor and others). Nothing else needs to be installed.

```bash
apart repl '
const pg = await openTab("https://github.com/notifications");
const s = await snapshot(pg, { interactive: true });
console.log(s.tree);
await pg.screenshot({ path: "inbox.jpg", type: "jpeg", quality: 60 });
console.log("DIR=" + pwd);
await closeTab(pg);
'
```

## How it works

```
terminal ── apart repl ──▶ daemon (Node, ~/.apart/daemon.sock)
                              │  runs your script in a vm sandbox
                              │  page.* calls become DevTools Protocol commands
                              ▼
                        ws://127.0.0.1:27170  ◀── Chrome extension (MV3, chrome.debugger)
                                                     opens tabs in an "apart" tab group,
                                                     attaches the debugger, relays commands
```

- **Daemon.** Started on demand by the CLI and kept running. It listens on a Unix socket (mode 0600) for scripts and on a loopback WebSocket for the extension. Scripts run in a `node:vm` context with only the documented globals: no `require`, no `process`, and a filesystem view confined to the per-run directory.
- **Extension.** Dials the daemon, answers pings so Chrome keeps the service worker alive, and executes tab and `chrome.debugger` requests. Tabs it opens come to the front so you can watch, are grouped under "apart", and are closed when the script ends or the daemon goes away; Chrome then returns to the tab you were on.
- **Reading pages.** `snapshot()` injects a small script into an isolated world that walks the DOM, computes ARIA roles and accessible names, and prints a tree with refs (`[ref=e12]`) for every interactive element. `snapshot().diff` shows what changed since the previous snapshot, ignoring ref renumbering.

No browser fork, no remote debugging port and no cloud service are involved: everything runs on your machine, through an extension you load yourself.

### Your Chrome or headless

Each run uses one of two browsers:

- **Your Chrome** (`--chrome`): the browser you are signed in to, through the extension. You can watch it work.
- **Headless** (`--headless`): a hidden Chrome the daemon starts itself, with its own signed-out profile in `~/.apart/headless-profile`. It needs no extension and works while your Chrome is closed. The daemon talks to it over a pipe, not a network port, starts it on the first headless run and closes it after five idle minutes.

Runs without a flag use your default browser. `./install.sh` asks for it the first time; change it later in the extension's Settings or with `apart config default-browser chrome|headless`. Both kinds of run appear in the extension's Activity page.

### The extension

- **Toolbar popup.** Whether the terminal can reach Chrome right now, and the last three runs. When it is not connected, it shows the command to start apart, with a Copy button and a Check now button.
- **Activity.** Every run with the pages it opened, which browser it used, how long it took and any error, searchable and filterable by result, browser, time and sort order. Headless runs made while Chrome was closed show up the next time the extension connects. Successful runs that open nothing (such as an agent's readiness check) are left out.
- **Settings.** Connection details, the default browser, whether tabs stay open when a script ends, the daemon port, a setup checklist, and what apart keeps: the last 200 runs, with page addresses stripped of query strings and fragments, stored in this browser and in `~/.apart/history.json`. Clearing it there removes both.

Tabs apart opens sit in a pink "apart" tab group, so they are easy to tell apart from yours.

## Requirements

- macOS or Linux, Node.js 22 or newer, yarn
- Google Chrome or Chromium (version 120 or newer)

## Install

```bash
git clone https://github.com/e6uka/apart.git
cd apart
./install.sh
```

The installer asks which browser runs should use by default (pass `--browser=chrome` or `--browser=headless` to skip the question). If you chose your Chrome, load the extension once: in Chrome open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked** and choose `dist/extension` (print its path with `apart extension-path`). Finish with:

```bash
apart doctor
```

`doctor` starts the daemon, checks the extension and the browser for headless runs, and tells you what, if anything, is missing. Chrome shows an "apart is debugging this browser" bar while a script runs; that is Chrome's standard notice for `chrome.debugger`.

## Using it from an agent

Any agent that can run shell commands can use apart. Tell it the command exists and point it at the [Script API](#script-api), for example in your project's `CLAUDE.md` or `AGENTS.md`:

```markdown
To read or act on a web page in my signed-in Chrome, run `apart repl '<script>'`.
Scripts use the Playwright-style API in https://github.com/e6uka/apart#script-api.
Open tabs with `openTab(url)`, read them with `snapshot(pg)`, and close them with `closeTab(pg)`.
The last line of output is `[ok …]` or `[error …]`.
```

### Optional: gstack

If you use [gstack](https://github.com/garrytan/gstack), its `/browse`, `/scrape`, `/qa` and `/design-review` skills can run through apart instead of gstack's own browser, so their runs appear in apart's Activity page. They look for a command named `aside` (on `PATH` or at `~/.local/bin/aside`), so install apart under that name as well:

```bash
./install.sh --gstack
```

This adds `~/.local/bin/aside` as a second link to the same binary. It is never created by default, and the installer skips it if a different program already uses that name. gstack calls `aside repl` without a flag, so its skills use apart's default browser: headless, or your Chrome. With your Chrome as the default and the extension not connected, they fall back to gstack's own headless browser as before. To undo it, delete `~/.local/bin/aside`.

## CLI

| Command | What it does |
| --- | --- |
| `apart repl '<js>'` | Run a script. Also `--file script.js`, `--file -` (stdin), `--timeout <ms>` (default 120 s), `--headless` or `--chrome` to pick the browser for this run. Exit code is always 0; the last line is `[ok 1.2s]` or `[error …]`. |
| `apart config default-browser chrome\|headless` | Set the browser runs use without a flag. `apart config` shows the current settings. |
| `apart config keep-tabs on\|off` | Leave tabs a script opened in your Chrome open when it ends, instead of closing them. Also in the extension's Settings. |
| `apart daemon start\|stop\|status\|restart` | Manage the background daemon. `repl` starts it automatically. |
| `apart doctor` | Check Node, the build, the shims, the daemon, the extension and the browser for headless runs. |
| `apart extension-path` | Print the unpacked extension directory. |
| `apart skills list` | Prints that no skills are installed (kept for gstack compatibility). |
| `apart exec` | Not supported; apart has no autonomous agent. |

Logs: `~/.apart/logs/daemon.log`. Run directories: `~/.apart/runs/<timestamp>/` (the last 50 are kept). Run history: `~/.apart/history.json`. Settings: `~/.apart/config.json`. Headless browser profile: `~/.apart/headless-profile/`. Set `APART_CHROME` to choose which Chrome or Chromium headless runs use.

## Script API

Each `repl` call is a fresh session. Variables do not persist between calls, and tabs the script opened are closed when it ends.

**Session**

- `page` — the most recently opened or attached tab (`null` if none)
- `tabs` — all tabs attached in this session
- `openTab(url)` → `Page` — open a tab in the "apart" group, switch to it in your Chrome (headless has nothing to switch), and wait for it to load
- `closeTab(page)` — close a tab you opened (a borrowed tab is only detached). Tabs left open close when the script ends, unless `keep-tabs` is on.
- `listBrowserTabs()` → `[{ targetId, url, title, active }]` — tabs already open in Chrome
- `attachBrowserTab(targetId)`, `attachActiveBrowserTab()` → `Page` — work in an existing tab
- `getTabByTargetId(targetId)`
- `snapshot(page, { interactive?: boolean })` → `{ tree, diff }`
- `annotatedScreenshot(page)` → `{ base64Image }` — PNG with ref labels drawn on the page
- `installPageScript(page, source)` — run `source` before every new document in that tab
- `fetch(url, init)` — runs inside the current page, so it carries that site's cookies
- `fs` (`readFile`, `writeFile`, `mkdir`, `readdir`, `stat`, `rm`, `copyFile`, `exists`), `path`, `pwd`, `Buffer`, `sleep(ms)`, `display(imageBytes)`, `console.log`

**Page**

- `goto(url, { timeout })`, `reload()`, `goBack()`, `goForward()`, `url()`, `title()`, `content()`
- `evaluate(fnOrString, ...args)` — in the page's main world; return JSON-serialisable values
- `locator(css | "e12" | "f1e3" | "[ref=e12]")`, `getByRole(role, { name, exact })`, `getByLabel(text)`, `getByText(text)`, `getByPlaceholder(text)`, `getByTestId(id)`
- `frameLocator(selector)` → `FrameLocator`, `frames()` → `[{ ref, name, url }]` — see [Frames](#frames)
- `fill`, `click`, `dblclick`, `type`, `press`, `check`, `uncheck`, `hover`, `focus`, `selectOption`, `setInputFiles`, `textContent`, `innerText`, `innerHTML`, `inputValue`, `getAttribute`, `isVisible` — shortcuts taking a selector
- `on(event, handler)`, `once(event, handler)`, `off(event, handler)`, `waitForEvent(event, { timeout, predicate })`, `waitForDownload()` — events are `"dialog"` and `"download"`, see [Dialogs](#dialogs) and [Downloads](#downloads)
- `waitForSelector(sel, { state, timeout })`, `waitForURL(pattern)`, `waitForLoadState()`, `waitForFunction(fn)`, `waitForTimeout(ms)`
- `screenshot({ path, type: "png" | "jpeg" | "webp", quality, fullPage, clip })` → `Buffer`
- `pdf({ path, format, landscape, printBackground, margin, pageRanges })` → `Buffer`
- `setViewportSize({ width, height })`, `bringToFront()`, `keyboard.press(key)`, `keyboard.type(text)`, `mouse.click(x, y)`
- `_sendToTarget(method, params)` — raw DevTools Protocol command

**Locator**

`click`, `dblclick`, `hover`, `focus`, `fill`, `clear`, `type`, `press`, `check`, `uncheck`, `selectOption`, `setInputFiles(files)`, `textContent`, `innerText`, `innerHTML`, `inputValue`, `getAttribute`, `isVisible`, `isHidden`, `isEnabled`, `isChecked`, `count`, `all`, `first`, `last`, `nth`, `boundingBox`, `evaluate(fn)`, `screenshot({ path, margin })`, `waitFor({ state, timeout })`, `scrollIntoViewIfNeeded`.

**FrameLocator**

`locator`, `getByRole`, `getByLabel`, `getByText`, `getByPlaceholder`, `getByTestId`, `frameLocator` (for a frame inside a frame), `first`, `last`, `nth`.

Relative paths given to `screenshot`, `pdf`, `setInputFiles` and `fs` resolve inside the run directory (`pwd`). Nothing a script does can read or write outside it.

### Frames

Snapshots include the content of iframes, same-site and cross-site, nested up to four deep and up to 20 frames per snapshot. Elements inside a frame get refs with the frame's number in front, such as `f1e3`, and work like any other ref:

```
- button "Pay" [ref=e4]
- iframe "Card details":
  - textbox "Card number" [ref=f1e1]
  - textbox "Expiry" [ref=f1e2]
```

```js
await pg.locator("f1e1").fill("4242 4242 4242 4242");
const card = pg.frameLocator('iframe[title="Card details"]');
await card.getByLabel("Expiry").fill("12/30");
await card.getByRole("button", { name: "Save" }).click();
```

`getByRole`, `getByText` and the other `pg.` locators search the top page only, as in Playwright; use `frameLocator` or a frame ref to reach inside a frame.

### Dialogs

`alert`, `confirm`, `prompt` and `beforeunload` dialogs are dismissed automatically unless the script handles them (`beforeunload` is accepted, so pages can be left). To answer them:

```js
pg.on("dialog", async (dialog) => {
  console.log(dialog.type(), dialog.message());
  if (dialog.type() === "prompt") await dialog.accept("my answer");
  else await dialog.accept();
});
await pg.click("#delete");
```

A dialog has `type()`, `message()`, `defaultValue()`, `accept(promptText?)` and `dismiss()`. A dialog the handler leaves alone is dismissed when the handler returns. `waitForEvent("dialog")` only watches: it resolves once the dialog has been dismissed.

### Uploads

`setInputFiles` fills an `<input type="file">` with files from the run directory, or with files built in the script. Up to 50 MB per call.

```js
await fs.writeFile("report.csv", "name,total\nada,3\n");
await pg.setInputFiles("#attachment", "report.csv");
await pg.getByLabel("Photos").setInputFiles([{ name: "a.png", mimeType: "image/png", buffer: pngBytes }]);
```

### Downloads

Files a page downloads are saved to `downloads/` in the run directory.

```js
const [download] = await Promise.all([pg.waitForEvent("download"), pg.click("text=Export")]);
console.log(download.suggestedFilename(), await download.path());
await download.saveAs("export.csv");
```

A download has `url()`, `suggestedFilename()`, `path()` (resolves when it has finished), `saveAs(path)` and `failure()`. In headless runs the file goes straight to the run directory. In your Chrome, Chrome saves it as usual, to your downloads folder, and apart copies it into the run directory; if Chrome is set to ask where to save each file, you will see that question.

## Security model

apart assumes the person, or agent, writing scripts is trusted, and that web pages are not.

- **Network.** Only loopback. The daemon binds `127.0.0.1:27170` for the extension and a Unix socket (mode 0600, in a 0700 directory) for the CLI. Nothing is reachable from other machines.
- **Who can run scripts.** Only processes running as your user, because only they can open the socket.
- **The extension link.** The daemon accepts the extension only when the WebSocket `Origin` is the pinned extension ID (`chrome-extension://omkiljjaphabkenjdljjaopfdfadjgab`). Web pages cannot set that header. A local process running as you can, and could take the extension's place to see which URLs scripts open and feed back fake results. It cannot reach your real tabs that way. Anything running as you can already read your Chrome profile, so this adds no new access, but it is the weakest link and is worth hardening (for example with Chrome native messaging) if apart grows.
- **Tabs.** Scripts drive only tabs they opened or were explicitly given with `attachBrowserTab`. Opened tabs are closed when the script ends or the daemon disconnects.
- **Headless.** The headless browser uses its own profile, never yours, and is controlled over a pipe to the daemon, so no debugging port is opened. Cookies set during headless runs stay in `~/.apart/headless-profile` between runs; delete that folder to sign out of everything there.
- **Files.** Scripts see a filesystem view confined to their run directory. Paths are resolved through symlinks before the check.
- **The script sandbox is not a security boundary.** Scripts run in a `node:vm` context with no `require`, `process` or Node built-ins. That prevents accidents, not determined escapes. Do not run scripts you would not run with `node` yourself.
- **Page content.** Anything a page returns (snapshot text, evaluate results, fetch bodies) is data from that site. Treat it as untrusted content, never as instructions.

## Limitations

- In your Chrome, apart cannot open or control `chrome://` pages, the Chrome Web Store or other extensions' pages: Chrome does not let extensions debug them. Headless runs can, so use `--headless` for those.
- In your Chrome, Chrome shows an "apart started debugging this browser" bar while a script runs. Chrome shows it for every extension that uses the debugger, and only a Chrome launch flag hides it. Headless runs show nothing.
- Frames: snapshots go four frames deep and include up to 20 frames; deeper or extra frames are left out.
- Uploads fill file inputs directly. A site that opens a file picker without a file input (some drag-and-drop widgets) cannot be given a file yet.

## Development

```bash
yarn install
yarn build          # dist/apart.js, dist/extension, dist/injected
yarn test           # unit tests
yarn test:e2e       # launches a headless Chrome with the extension (needs Chrome for Testing or Chrome)
yarn typecheck
```

## Privacy

apart has no servers, accounts or analytics, and nothing it handles leaves your computer. See [PRIVACY.md](PRIVACY.md).

## License

MIT
