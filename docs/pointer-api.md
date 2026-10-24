# Pointer API gaps

Found while testing drag-to-reschedule on Medly's theatre timeline (2026-10-24). The script failed with `TypeError: pg.mouse.down is not a function`, and then `h.dragTo is not a function`.

## What exists

`src/daemon/page.ts`:

| Call | CDP sent |
| --- | --- |
| `mouse.click(x, y, { button, clickCount })` | `mouseMoved`, then `mousePressed` + `mouseReleased` per click |
| `mouse.move(x, y)` | one `mouseMoved`, no `button` or `buttons` |
| `mouse.wheel(dx, dy)` | `mouseWheel` at 0,0 |
| `keyboard.press(key)`, `keyboard.type(text)` | `dispatchKeyEvent`, `insertText` |

## What's missing (Playwright has these)

- `mouse.down({ button })` and `mouse.up({ button })`: press and release without a click.
- `mouse.move(x, y, { steps })`: steps let pages see intermediate moves. Most drag code ignores moves under a few pixels of threshold, and a single jump can skip hover targets.
- Moves made while a button is held must send `button` and `buttons` (for example `button: "left", buttons: 1`). Without them, `pointermove` reports `buttons === 0`, and libraries that check for a held button cancel the drag.
- `locator.dragTo(target, { sourcePosition, targetPosition })` and `page.dragAndDrop(source, target)`.
- `mouse.wheel` scrolls at 0,0. It should scroll at the last mouse position, so wheel events reach scrollable children rather than the document.
- Touch: `page.touchscreen.tap(x, y)` and touch drags (`Input.dispatchTouchEvent`) for testing phone layouts.

## Suggested implementation

Track the last position and held buttons on `Page`:

```ts
private pointer = { x: 0, y: 0, buttons: 0 };
const BIT = { left: 1, right: 2, middle: 4 };

down({ button = "left", clickCount = 1 } = {}) {
  this.pointer.buttons |= BIT[button];
  return this.send("Input.dispatchMouseEvent", { type: "mousePressed", ...this.at(), button, buttons: this.pointer.buttons, clickCount });
}

up({ button = "left", clickCount = 1 } = {}) {
  this.pointer.buttons &= ~BIT[button];
  return this.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...this.at(), button, buttons: this.pointer.buttons, clickCount });
}

async move(x, y, { steps = 1 } = {}) {
  const from = { ...this.pointer };
  for (let i = 1; i <= steps; i++) {
    this.pointer.x = from.x + ((x - from.x) * i) / steps;
    this.pointer.y = from.y + ((y - from.y) * i) / steps;
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...this.at(), button: held(this.pointer.buttons), buttons: this.pointer.buttons });
  }
}
```

`held` returns `"left"` when bit 1 is set (and so on), or `"none"`. `click` should go through `move`, `down` and `up` so the position stays tracked.

`locator.dragTo(target, opts)`:

1. Scroll both elements into view and resolve their boxes. By default use the centres; otherwise use `sourcePosition` and `targetPosition`, which are relative to each box.
2. Run the same "covered by" check `click` already does, on the source point.
3. Call `move(source)`, then `down()`, then `move(target, { steps: 10 })`, then `up()`.
4. HTML5 drag and drop (`draggable="true"`) doesn't fire from synthetic mouse events. For it, call `Input.setInterceptDrags({ enabled: true })`, wait for `Input.dragIntercepted`, then send `Input.dispatchDragEvent` (`dragEnter`, `dragOver`, `drop`) with the intercepted data.

Update the Script API list in the README once these land.

## Workaround until then

Fire pointer events inside the page. React and most drag code listen for these, but `isTrusted` is false and nothing goes through the browser's hit testing:

```js
await pg.evaluate(() => {
  const h = document.querySelector('[aria-label^="Move Myomectomy"]');
  const r = h.getBoundingClientRect();
  const x = r.x + r.width / 2, y = r.y + r.height / 2;
  const at = (cx, buttons) => ({ bubbles: true, clientX: cx, clientY: y, pointerType: "mouse", button: 0, buttons, isPrimary: true });
  h.dispatchEvent(new PointerEvent("pointerdown", at(x, 1)));
  for (let i = 1; i <= 8; i++) window.dispatchEvent(new PointerEvent("pointermove", at(x + i * 16, 1)));
  window.dispatchEvent(new PointerEvent("pointerup", at(x + 128, 0)));
});
```
