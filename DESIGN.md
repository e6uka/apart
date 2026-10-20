# Design brief

## Product
- What it is: a local tool that lets terminal agents (Claude Code with gstack) drive tabs in the user's own signed-in Chrome. `confirmed`
- Primary audience and context of use: developers at a desk on macOS, terminal open all day. They open the extension rarely: to check it is connected and to see what the agent just did. `assumed`
- Secondary audience: people they share the repo with, judging it from the README and GitHub card. `assumed`
- Job of the key screens:
  - Toolbar popup: answer "is it connected, and what did it just do?" in one glance; fix it in one step when it is not.
  - Settings page: connection details, port, setup checklist.
  - Activity log: find a past run by site or result.
- First 5 seconds: see the connection state in words and colour, and the last run. `designer's call`

## Personality
- Position on: calm 3 / energetic 7 → calm; premium 4 / everyday 6 → everyday; playful 4 / serious 6 → friendly but plain; local / global → global. "Friendly utility". `confirmed`
- Admired references and why: not given. `assumed`
- Must not resemble: the user's other projects; no accent hue already used across their GitHub repos (reds, ambers, olive, greens, blues, indigo and violet). `confirmed`
- Category: stands apart from dev-tool blue, purple and terminal green. `designer's call`

## Brand (fixed vs flexible)
- Logo: mark B2 "tab on the edge": a rounded ink window with a pale title bar and a berry tab sitting on its top edge, a 4-unit gap below the tab. Fixed. `confirmed`
- Colors: berry accent, berry-tinted warm neutrals. Fixed. `confirmed`
- Type: Figtree (OFL), bundled. `designer's call`
- Imagery: none; the mark and real UI only. `designer's call`
- Voice: plain, short, second person, says what to do next. No jargon in status lines; commands shown in monospace so they can be copied. `designer's call`

## Platforms
- Targets and priority: Chrome extension popup (fixed 360 px wide), extension settings page (responsive 320 to 1440 px), README and GitHub social card. `confirmed`
- Native look per OS or shared brand look: shared brand look.
- Themes (light/dark): both, following the system setting. `designer's call`
- Locales: English only for now. `assumed`

## Constraints
- Accessibility beyond AA: none stated; AA contrast, visible focus, keyboard reachable, status never by colour alone. `assumed`
- Devices, network, performance: works offline; no remote fonts or scripts in the extension (MV3 CSP). `confirmed`
- Existing system/components: none; plain HTML, CSS and TypeScript bundled with esbuild. `confirmed`
- List pages follow the user's list rules: one search box plus one Filters popover, removable chips with Clear all, state in the URL, debounced search, page resets on filter change, loading/empty/nothing-matches/error states. `confirmed`

## Motion
- Level and purpose: state feedback only (focus, press, popover open). `designer's call`
- Signature moment: when the extension connects, the berry status tab settles onto the card edge (160 ms, transform only). Off under `prefers-reduced-motion`.

## Success
- Measures: a first-time user gets from "not connected" to "connected" from the popup alone; the user recognises the toolbar icon at 16 px. `assumed`
- Never: em or en dashes in UI copy; status by colour alone; remote assets in the extension.

## Design decisions (filled in by the designer)
- Palette tokens:

  | Token | Light | Dark |
  | --- | --- | --- |
  | `--bg` | `#FBF7F8` paper | `#1B1620` night |
  | `--surface` | `#FFFFFF` | `#241D2A` |
  | `--text` | `#241B2C` ink | `#F6EEF3` |
  | `--muted` | `#6E6273` | `#B3A6B4` |
  | `--line` | `#EADFE5` | `#3A3040` |
  | `--accent` | `#C4307C` berry | `#EE6AAA` |
  | `--accent-soft` | `#F8E1EC` | `#3B2131` |
  | `--ok` | `#1F7A55` | `#5CC79A` |
  | `--error` | `#B3261E` | `#FF8A80` |

  Chrome's tab group for agent tabs uses the `pink` colour so tabs carry the brand.
- Type scale (1.2): 12, 14, 16, 19, 23 px. Body 14 in the popup (mouse-driven desktop surface), 16 on the settings page. Weights 400 body, 600 labels, 700 headings and the wordmark. Monospace (`ui-monospace`) only for commands, ports and URLs.
- Radius and elevation: controls 8, cards 12, chips and status pills fully round. One shadow, used only by the Filters popover. Grouping otherwise by surface tone and 1 px lines.
- Signature element: the berry tab on the status card edge, repeating the logo.
- Log of conscious rule breaks:
  - Popup body text is 14 px, below the 16 px mobile-web floor; the popup is a desktop, pointer-only surface with a fixed width.
  - Toolbar icons at 16 and 32 px add a 1 px paper outline to the ink window so the mark stays visible on dark Chrome toolbars.
  - Successful runs that open and visit nothing (gstack's readiness probe) are not recorded, so they cannot bury real runs. Failures are always recorded.
