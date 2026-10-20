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
> You install the free, open source apart command line tool, then run a Playwright-style script with `apart repl`. This extension receives those commands from apart on your computer, opens tabs in a pink "apart" tab group, works in them and reports back. When the script ends, its tabs close.
>
> What you get in the browser:
> • A toolbar popup that shows whether your terminal can reach Chrome, with the command to run when it cannot.
> • An activity log of every run, the pages it opened and any error, with search and filters.
> • A settings page with the connection details and a setup checklist.
>
> What it will not do:
> • It never talks to any server. It only connects to apart on your own computer (127.0.0.1).
> • It only touches tabs a script opened, or a tab you hand to a script on purpose.
> • It does not read or export your cookies or passwords.
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

Then tick all three certifications: not sold to third parties, not used for purposes unrelated to the single purpose, not used for creditworthiness or lending.

**Privacy policy URL:** https://github.com/e6uka/apart/blob/main/PRIVACY.md

## Distribution

- **Visibility:** Public, or Unlisted if you only want people with the link to find it.
- **Regions:** All.
- **Price:** Free.

## What to expect in review

- `debugger` triggers a manual, in-depth review. Expect several days, sometimes a few weeks.
- Reviewers may ask how to test it. Answer in the "Notes for reviewer" field:

  > The extension does nothing on its own; it needs the open source apart command line tool. To test: install Node.js 22, run `git clone https://github.com/e6uka/apart && cd apart && ./install.sh && apart doctor`, then `apart repl 'const pg = await openTab("https://example.com"); console.log(await pg.title()); await closeTab(pg);'`. A tab opens in a pink "apart" group, the title prints in the terminal, and the run appears in the extension's Activity page.

## After the first upload

The store gives the extension its own ID, different from the unpacked one (`omkiljjaphabkenjdljjaopfdfadjgab`). Add it to `STORE_EXTENSION_IDS` in `src/shared/protocol.ts` and release a new version of the command line tool, so the daemon accepts the store version. Until then, users of the store version can set `APART_EXTENSION_IDS=<store id>` before starting the daemon.
