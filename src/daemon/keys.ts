export interface KeyDescriptor {
  key: string;
  code: string;
  keyCode: number;
  text?: string;
  modifiers: number;
}

const MODIFIER_BITS: Record<string, number> = { alt: 1, control: 2, ctrl: 2, meta: 4, cmd: 4, command: 4, shift: 8 };

const NAMED_KEYS: Record<string, Omit<KeyDescriptor, "modifiers">> = {
  enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  return: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  tab: { key: "Tab", code: "Tab", keyCode: 9 },
  escape: { key: "Escape", code: "Escape", keyCode: 27 },
  esc: { key: "Escape", code: "Escape", keyCode: 27 },
  backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
  delete: { key: "Delete", code: "Delete", keyCode: 46 },
  space: { key: " ", code: "Space", keyCode: 32, text: " " },
  arrowup: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  arrowdown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  arrowleft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  arrowright: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  home: { key: "Home", code: "Home", keyCode: 36 },
  end: { key: "End", code: "End", keyCode: 35 },
  pageup: { key: "PageUp", code: "PageUp", keyCode: 33 },
  pagedown: { key: "PageDown", code: "PageDown", keyCode: 34 },
  insert: { key: "Insert", code: "Insert", keyCode: 45 },
  f1: { key: "F1", code: "F1", keyCode: 112 },
  f2: { key: "F2", code: "F2", keyCode: 113 },
  f3: { key: "F3", code: "F3", keyCode: 114 },
  f4: { key: "F4", code: "F4", keyCode: 115 },
  f5: { key: "F5", code: "F5", keyCode: 116 },
  f12: { key: "F12", code: "F12", keyCode: 123 },
};

const SHIFTED: Record<string, string> = {
  "!": "1", "@": "2", "#": "3", "$": "4", "%": "5", "^": "6", "&": "7", "*": "8", "(": "9", ")": "0",
  "_": "-", "+": "=", "{": "[", "}": "]", "|": "\\", ":": ";", "\"": "'", "<": ",", ">": ".", "?": "/", "~": "`",
};

const PUNCTUATION_CODES: Record<string, { code: string; keyCode: number }> = {
  "-": { code: "Minus", keyCode: 189 }, "=": { code: "Equal", keyCode: 187 }, "[": { code: "BracketLeft", keyCode: 219 },
  "]": { code: "BracketRight", keyCode: 221 }, "\\": { code: "Backslash", keyCode: 220 }, ";": { code: "Semicolon", keyCode: 186 },
  "'": { code: "Quote", keyCode: 222 }, ",": { code: "Comma", keyCode: 188 }, ".": { code: "Period", keyCode: 190 },
  "/": { code: "Slash", keyCode: 191 }, "`": { code: "Backquote", keyCode: 192 },
};

export function keyDescriptor(spec: string): KeyDescriptor {
  const parts = spec.split("+");
  const last = parts.pop() ?? "";
  let modifiers = 0;
  for (const part of parts) {
    const bit = MODIFIER_BITS[part.toLowerCase()];
    if (bit === undefined) throw new Error(`Unknown modifier: ${part}`);
    modifiers |= bit;
  }
  const named = NAMED_KEYS[last.toLowerCase()];
  if (named) return { ...named, text: modifiers & ~8 ? undefined : named.text, modifiers };
  if (last.length !== 1) throw new Error(`Unknown key: ${last}`);
  const base = SHIFTED[last] ?? last;
  if (SHIFTED[last]) modifiers |= 8;
  const upper = base.toUpperCase();
  let code: string;
  let keyCode: number;
  if (/[a-z]/i.test(base)) {
    code = `Key${upper}`;
    keyCode = upper.charCodeAt(0);
  } else if (/[0-9]/.test(base)) {
    code = `Digit${base}`;
    keyCode = base.charCodeAt(0);
  } else {
    const punct = PUNCTUATION_CODES[base];
    code = punct?.code ?? "Unidentified";
    keyCode = punct?.keyCode ?? 0;
  }
  const shifted = (modifiers & 8) !== 0;
  const key = /[a-z]/i.test(last) ? (shifted ? last.toUpperCase() : last) : last;
  return { key, code, keyCode, text: modifiers & ~8 ? undefined : key, modifiers };
}
