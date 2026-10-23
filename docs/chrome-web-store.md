# Chrome Web Store submission

Everything the developer dashboard asks for, ready to paste. Upload `dist/store/apart-extension-<version>.zip`, built with `yarn package:store`.

## Store listing

**Name:** apart

**Summary (132 characters max):**

> Lets the apart command line tool open and use tabs in your own signed-in Chrome, so your scripts and terminal agents can browse.

**Category:** Developer Tools

**Language:** English

**Description:**

> apart lets scripts and coding agents in your terminal use your real Chrome: the one you are already signed in to.
>
> You install the free, open source apart command line tool, then run a Playwright-style script with `apart repl`. This extension receives those commands from apart on your computer, opens tabs in a pink "apart" tab group, works in them and reports back: what the page says, what changed, screenshots and PDFs. Scripts can fill forms, reach inside embedded frames, answer dialogs, upload files and save downloads. When the script ends, its tabs close.
>
> apart can also run scripts in a hidden headless Chrome of its own. You choose which one runs by default, and every run from both shows up in this extension's activity log.
>
> What you get in the browser:
> • A toolbar popup that shows whether your terminal can reach Chrome, with the command to run when it cannot.
> • An activity log of every run, the pages it opened, whether it ran in your Chrome or headless, and any error, with search and filters.
> • A settings page with the connection details, the default browser and a setup checklist.
>
> What it will not do:
> • It never talks to any server. It only connects to apart on your own computer (127.0.0.1).
> • It only touches tabs a script opened, or a tab you hand to a script on purpose.
> • It does not read or export your cookies or passwords.
> • It only looks at downloads that finish while a script is running.
>
> Chrome shows "apart started debugging this browser" while a script runs. That is Chrome's standard notice for extensions that use the debugger.
>
> Requires the apart command line tool: https://github.com/e6uka/apart

**Graphics** (all in `design/store/`):

| Asset | File |
| --- | --- |
| Store icon, 128×128 | `icon-128.png` |
| Small promo tile, 440×280 | `promo-tile-440x280.png` |
| Screenshots, 1280×800 | `screenshot-1-popup.png` to `screenshot-5-activity-dark.png` |

**Homepage URL:** https://github.com/e6uka/apart

**Support URL:** https://github.com/e6uka/apart/issues

## Privacy practices tab

**Single purpose:**

> apart lets the apart command line tool, running on the user's own computer, open and control browser tabs on the user's behalf, so scripts and terminal agents the user runs can read and act on web pages in the user's signed-in browser.

**Permission justifications:**

| Permission | Justification |
| --- | --- |
| `debugger` | The extension's core function. apart's scripts click, type, read page content and take screenshots in tabs, which needs the Chrome DevTools Protocol. It attaches only to tabs the user's script opened or the user explicitly handed to a script, and detaches when the script ends. |
| `tabs` | To open tabs for a script, close them when it ends, and list open tabs when a script asks to work in one the user chooses. |
| `tabGroups` | To put tabs apart opens in a labelled "apart" group, so the user can tell them apart from their own tabs. |
| `alarms` | To reconnect to the apart program on the user's computer after Chrome suspends the service worker. |
| `storage` | To keep the user's port setting and the local history of recent runs shown in the activity log. |
| `downloads` | When a script the user runs downloads a file, to find where Chrome saved it so the apart program on the user's computer can copy it into that run's folder. Only downloads that finish while a script is running are looked at, and nothing is sent anywhere else. |

**Remote code:**

> No, I am not using remote code. All extension code is in the package. The extension relays Chrome DevTools Protocol commands sent by the apart program the user runs on their own computer (over 127.0.0.1); it does not download or run code from any server.

**Data usage.** Tick these, because the extension handles them, even though nothing leaves the device:

- **Website content:** page text and screenshots are passed to the apart program on the user's computer, for the script the user ran.
- **Web history:** the activity log keeps the addresses of pages each run visited, without query strings or fragments, in local extension storage.

Downloaded files a script triggers stay on the user's computer: Chrome saves them as usual, and the extension tells the apart program where, so it can copy them into that run's folder. That is covered by Website content.

Then tick all three certifications: not sold to third parties, not used for purposes unrelated to the single purpose, not used for creditworthiness or lending.

**Privacy policy URL:** https://github.com/e6uka/apart/blob/main/PRIVACY.md

## Distribution

- **Visibility:** Public, or Unlisted if you only want people with the link to find it.
- **Regions:** All.
- **Price:** Free.

## What to expect in review

- `debugger` triggers a manual, in-depth review. Expect several days, sometimes a few weeks. `downloads` is a second sensitive permission; the justification above explains why it is needed.
- Reviewers may ask how to test it. Answer in the "Notes for reviewer" field:

  > The extension does nothing on its own; it needs the open source apart command line tool. To test: install Node.js 22, run `npm install -g apart-browser && apart setup --browser chrome && apart doctor`, then `apart repl --chrome 'const pg = await openTab("https://example.com"); console.log(await pg.title()); await closeTab(pg);'`. A tab opens in a pink "apart" group, the title prints in the terminal, and the run appears in the extension's Activity page. To check the downloads permission: `apart repl --chrome 'const pg = await openTab("https://example.com"); await pg.evaluate(() => { const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob(["hello"])); a.download = "hello.txt"; a.id = "dl"; a.textContent = "Download"; document.body.append(a); }); const [d] = await Promise.all([pg.waitForEvent("download"), pg.click("#dl")]); console.log(await d.path()); await closeTab(pg);'`. Chrome saves hello.txt to the downloads folder and the terminal prints the copy in the run folder.

## When the extension is live on the store

The store gives the extension its own ID, different from the unpacked one (`omkiljjaphabkenjdljjaopfdfadjgab`), because the store package has no `key` in its manifest. Until the CLI knows that ID, the daemon refuses the store version; in the meantime its users can set `APART_EXTENSION_IDS=<store id>` before starting the daemon.

Work through this list in order, on a feature branch.

**Accept the store extension**

- [ ] Copy the ID and listing URL from the developer dashboard.
- [ ] Add the ID to `STORE_EXTENSION_IDS` in `src/shared/protocol.ts`.
- [ ] Add a test to `test/extension-ids.test.ts` that `allowedExtensionIds("")` includes the store ID.

**Point people to the store**

- [ ] README "Install": make the store link step 2, right after `npm install -g apart-browser`. Move Developer mode and Load unpacked to a short "Without the store" note (for Chromium browsers without store access, or for testing a local build).
- [ ] README "The extension": add the store link, and drop the line about the extension not being on the store yet.
- [ ] `apart setup`, and the hint `apart doctor` gives when no browser is connected (`loadExtension` in `src/cli/main.ts`): show the store link first, and the unpacked folder second.
- [ ] Daemon errors that say how to load the extension (`src/daemon/index.ts`, `src/daemon/bridge.ts`): mention the store.
- [ ] Extension settings, "First-time setup" (`src/extension/options.html`): people reading it already have the extension, so make sure the steps start at `npm install -g apart-browser`.
- [ ] Add the store link to the npm package description or README badge, so npmjs.com shows it.

**Handle version drift**

The store updates the extension on its own, and review can take days, so the extension and the CLI will not always match.

- [ ] Change the out-of-date message in `apart doctor`. For a store install, "reload the extension" does nothing: when the CLI is newer, say the store update is on its way (or check for updates in `chrome://extensions`); when the extension is newer, say `npm install -g apart-browser@latest`.
- [ ] Keep the CLI and the extension talking across one version of difference. Do not change `PROTOCOL_VERSION` in a way that breaks a store extension still waiting for review.
- [ ] Release order from now on: submit the store package first, publish to npm once it is approved, unless the npm release works with the extension already on the store.

**People moving from unpacked to store**

- [ ] README: tell them to remove the unpacked copy in `chrome://extensions` after adding the store one. With both loaded in the same browser, both connect under the same name and the newest takes over.
- [ ] Mention that the extension's own settings (custom browser name, port) do not carry over, because the store copy is a different extension. Run history does carry over through `~/.apart/history.json`.
- [ ] Consider an `apart doctor` warning when the same browser connects twice, once with the unpacked ID and once with the store ID.

**Release**

- [ ] Bump the minor version in `package.json` and `src/extension/manifest.json`, in its own "Bump version" commit.
- [ ] PR, merge, then `npm publish` from `main`.
- [ ] Check a clean install: `npm install -g apart-browser`, add from the store, `apart setup`, `apart doctor`.

**Every later release**

- [ ] `yarn package:store` and upload `dist/store/apart-extension-<version>.zip` whenever extension code changes.
- [ ] Update the store listing and screenshots in `design/store/` when the popup, Activity or Settings pages change.
