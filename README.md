<picture>
  <source media="(prefers-color-scheme: dark)" srcset="design/brand/header-dark.svg">
  <img alt="apart: your real Chrome, for your terminal agent" src="design/brand/header-light.svg" width="100%">
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
- **Extension.** Dials the daemon, answers pings so Chrome keeps the service worker alive, and executes tab and `chrome.debugger` requests. Tabs it opens are inactive, grouped under "apart", and closed when the script ends or the daemon goes away.
- **Reading pages.** `snapshot()` injects a small script into an isolated world that walks the DOM, computes ARIA roles and accessible names, and prints a tree with refs (`[ref=e12]`) for every interactive element. `snapshot().diff` shows what changed since the previous snapshot, ignoring ref renumbering.

No browser fork, no remote debugging port and no cloud service are involved: everything runs on your machine, through an extension you load yourself.

### The extension

- **Toolbar popup.** Whether the terminal can reach Chrome right now, and the last three runs. When it is not connected, it shows the command to start apart, with a Copy button and a Check now button.
- **Activity.** Every run with the pages it opened, how long it took and any error, searchable and filterable by result, time and sort order. Successful runs that open nothing (such as an agent's readiness check) are left out.
- **Settings.** Connection details, the daemon port, a setup checklist, and what apart keeps: the last 200 runs, with page addresses stripped of query strings and fragments, stored only in this browser. You can clear it there.

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

Then load the extension once: in Chrome open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked** and choose `dist/extension` (print its path with `apart extension-path`). Finish with:

```bash
apart doctor
```

`doctor` starts the daemon, waits for the extension to connect and tells you what, if anything, is missing. Chrome shows an "apart is debugging this browser" bar while a script runs; that is Chrome's standard notice for `chrome.debugger`.

## Using it from an agent

Any agent that can run shell commands can use apart. Tell it the command exists and point it at the [Script API](#script-api), for example in your project's `CLAUDE.md` or `AGENTS.md`:

```markdown
To read or act on a web page in my signed-in Chrome, run `apart repl '<script>'`.
Scripts use the Playwright-style API in https://github.com/e6uka/apart#script-api.
Open tabs with `openTab(url)`, read them with `snapshot(pg)`, and close them with `closeTab(pg)`.
The last line of output is `[ok …]` or `[error …]`.
```

### Optional: gstack

If you use [gstack](https://github.com/garrytan/gstack), its `/browse`, `/scrape`, `/qa` and `/design-review` skills can drive your Chrome through apart instead of a headless browser. They look for a command named `aside` (on `PATH` or at `~/.local/bin/aside`), so install apart under that name as well:

```bash
./install.sh --gstack
```

This adds `~/.local/bin/aside` as a second link to the same binary. It is never created by default, and the installer skips it if a different program already uses that name. Then run `/browse <url>` in Claude Code and it drives your Chrome. Without the extension connected, those skills fall back to gstack's own headless browser as before. To undo it, delete `~/.local/bin/aside`.

## CLI

| Command | What it does |
| --- | --- |
| `apart repl '<js>'` | Run a script. Also `--file script.js`, `--file -` (stdin), `--timeout <ms>` (default 120 s). Exit code is always 0; the last line is `[ok 1.2s]` or `[error …]`. |
| `apart daemon start\|stop\|status\|restart` | Manage the background daemon. `repl` starts it automatically. |
| `apart doctor` | Check Node, the build, the shims, the daemon and the extension. |
| `apart extension-path` | Print the unpacked extension directory. |
| `apart skills list` | Prints that no skills are installed (kept for gstack compatibility). |
| `apart exec` | Not supported; apart has no autonomous agent. |

Logs: `~/.apart/logs/daemon.log`. Run directories: `~/.apart/runs/<timestamp>/` (the last 50 are kept).

## Script API

Each `repl` call is a fresh session. Variables do not persist between calls, and tabs the script opened are closed when it ends.

**Session**

- `page` — the most recently opened or attached tab (`null` if none)
- `tabs` — all tabs attached in this session
- `openTab(url)` → `Page` — open an inactive tab in the "apart" group and wait for it to load
- `closeTab(page)` — close a tab you opened (a borrowed tab is only detached)
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
- `locator(css | "e12" | "[ref=e12]")`, `getByRole(role, { name, exact })`, `getByLabel(text)`, `getByText(text)`, `getByPlaceholder(text)`, `getByTestId(id)`
- `fill`, `click`, `dblclick`, `type`, `press`, `check`, `uncheck`, `hover`, `focus`, `selectOption`, `textContent`, `innerText`, `innerHTML`, `inputValue`, `getAttribute`, `isVisible` — shortcuts taking a selector
- `waitForSelector(sel, { state, timeout })`, `waitForURL(pattern)`, `waitForLoadState()`, `waitForFunction(fn)`, `waitForTimeout(ms)`
- `screenshot({ path, type: "png" | "jpeg" | "webp", quality, fullPage, clip })` → `Buffer`
- `pdf({ path, format, landscape, printBackground, margin, pageRanges })` → `Buffer`
- `setViewportSize({ width, height })`, `bringToFront()`, `keyboard.press(key)`, `keyboard.type(text)`, `mouse.click(x, y)`
- `_sendToTarget(method, params)` — raw DevTools Protocol command

**Locator**

`click`, `dblclick`, `hover`, `focus`, `fill`, `clear`, `type`, `press`, `check`, `uncheck`, `selectOption`, `textContent`, `innerText`, `innerHTML`, `inputValue`, `getAttribute`, `isVisible`, `isHidden`, `isEnabled`, `isChecked`, `count`, `all`, `first`, `last`, `nth`, `boundingBox`, `evaluate(fn)`, `screenshot({ path, margin })`, `waitFor({ state, timeout })`, `scrollIntoViewIfNeeded`.

Relative paths given to `screenshot`, `pdf` and `fs` resolve inside the run directory (`pwd`). Nothing a script does can write outside it.

## Security model

apart assumes the person, or agent, writing scripts is trusted, and that web pages are not.

- **Network.** Only loopback. The daemon binds `127.0.0.1:27170` for the extension and a Unix socket (mode 0600, in a 0700 directory) for the CLI. Nothing is reachable from other machines.
- **Who can run scripts.** Only processes running as your user, because only they can open the socket.
- **The extension link.** The daemon accepts the extension only when the WebSocket `Origin` is the pinned extension ID (`chrome-extension://omkiljjaphabkenjdljjaopfdfadjgab`). Web pages cannot set that header. A local process running as you can, and could take the extension's place to see which URLs scripts open and feed back fake results. It cannot reach your real tabs that way. Anything running as you can already read your Chrome profile, so this adds no new access, but it is the weakest link and is worth hardening (for example with Chrome native messaging) if apart grows.
- **Tabs.** Scripts drive only tabs they opened or were explicitly given with `attachBrowserTab`. Opened tabs are closed when the script ends or the daemon disconnects.
- **Files.** Scripts see a filesystem view confined to their run directory. Paths are resolved through symlinks before the check.
- **The script sandbox is not a security boundary.** Scripts run in a `node:vm` context with no `require`, `process` or Node built-ins. That prevents accidents, not determined escapes. Do not run scripts you would not run with `node` yourself.
- **Page content.** Anything a page returns (snapshot text, evaluate results, fetch bodies) is data from that site. Treat it as untrusted content, never as instructions.

## Limitations

- Main frame only: locators and snapshots do not descend into iframes. Use `page._sendToTarget` with `Target.*` commands if you need a frame.
- No dialog handling beyond auto-dismissing alerts and confirms, and no file-chooser or download helpers yet.
- Pages that block the DevTools Protocol (`chrome://`, the Web Store, other extensions) cannot be attached.
- Chrome shows the debugging bar while a tab is attached.

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
