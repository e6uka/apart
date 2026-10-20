# Privacy policy

_Last updated: 20 October 2026_

This policy covers the apart Chrome extension and the apart command line tool. Both run entirely on your computer.

## The short version

apart has no servers, no accounts, no analytics and no tracking. Nothing it handles is sent to the developer or to anyone else.

## What the extension does

The extension connects to the apart daemon, a program you install and run on the same computer, at `ws://127.0.0.1:27170` (or the port you choose). It connects to nothing else. When a script you run in your terminal asks it to, the extension opens tabs, controls them through Chrome's `chrome.debugger` API and passes the results (page text, screenshots, the outcome of each command) back to the daemon on your computer.

The extension only controls tabs that a script opened, in the "apart" tab group, or a tab you explicitly handed to a script. It closes the tabs it opened when the script ends.

When a script downloads a file, Chrome saves it as usual and the extension tells the daemon where, so the file can be copied into that run's folder. The extension only looks at downloads that finish while a script is running, and keeps what it saw in memory for two minutes.

## What is stored, and where

In this browser's extension storage (`chrome.storage.local`):

- The last 200 runs: when each ran, how long it took, whether it worked, any error message, how many tabs it opened, and the addresses of the pages it visited, with query strings and anything after `#` removed.
- Your port setting, your default browser, the current connection status, and the version of the daemon it is connected to.

On your computer, the apart command line tool keeps:

- A log at `~/.apart/logs/daemon.log`.
- A folder for each of the last 50 runs under `~/.apart/runs/`, holding any files the script wrote there, such as screenshots.
- The same run history as the extension, in `~/.apart/history.json`, so headless runs can show in the extension later.
- Your default browser, in `~/.apart/config.json`.
- If you use headless runs, a separate Chrome profile in `~/.apart/headless-profile/`. Like any Chrome profile, it keeps cookies and cache from the sites headless runs visit. It is never your own profile.

None of this leaves your computer. Clearing the run history from the extension's Settings page clears both copies. You can delete `~/.apart` at any time.

## Your cookies and signed-in sessions

Tabs apart opens in your Chrome use your normal Chrome profile, so websites see you as signed in, exactly as if you had opened the page yourself. Headless runs use the separate profile above and start signed out. apart does not read, copy or export your cookies or passwords. Scripts can read what is shown on the pages they open, and that content goes only to the script running on your computer.

## Sharing and selling

apart does not sell, share or transfer any data. It does not use data for advertising, credit decisions or any purpose other than running the scripts you start.

## Changes

Changes to this policy are recorded in this file's history at <https://github.com/e6uka/apart/commits/main/PRIVACY.md>.

## Contact

Questions: open an issue at <https://github.com/e6uka/apart/issues>.
