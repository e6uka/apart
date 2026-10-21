import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { Resvg } from "@resvg/resvg-js";
import opentype from "opentype.js";

const BRAND_DIR = "design/brand";
const ICON_DIR = "src/extension/icons";
const FONT_DIR = "node_modules/@fontsource/figtree/files";

const C = {
  berry: "#C4307C",
  berryNight: "#EE6AAA",
  ink: "#241B2C",
  paper: "#FBF7F8",
  night: "#1B1620",
  muted: "#6E6273",
  mutedNight: "#B3A6B4",
};

const THEMES = {
  light: { window: C.ink, bar: C.paper, barOpacity: 0.5, tab: C.berry, text: C.ink, sub: C.muted, bg: C.paper },
  dark: { window: C.paper, bar: C.ink, barOpacity: 0.45, tab: C.berryNight, text: C.paper, sub: C.mutedNight, bg: C.night },
};

function loadFont(weight) {
  const buffer = readFileSync(path.join(FONT_DIR, `figtree-latin-${weight}-normal.woff`));
  return opentype.parse(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));
}

const bold = loadFont(700);
const regular = loadFont(400);

function markShapes(theme, { outline = 0 } = {}) {
  const t = THEMES[theme];
  const stroke = outline ? ` stroke="${theme === "light" ? C.paper : C.ink}" stroke-width="${outline}" paint-order="stroke"` : "";
  return [
    `<rect x="12" y="38" width="104" height="76" rx="20" fill="${t.window}"${stroke}/>`,
    `<rect x="24" y="50" width="28" height="8" rx="4" fill="${t.bar}" fill-opacity="${t.barOpacity}"/>`,
    `<path d="M58 30c0-9 6-16 15-16h22c9 0 15 7 15 16v4H58z" fill="${t.tab}"${stroke}/>`,
  ].join("");
}

function markSvg(theme, { size = 128, viewBox = "8 8 112 112", outline = 0, background = null } = {}) {
  const bg = background ? `<rect x="-1000" y="-1000" width="3000" height="3000" fill="${background}"/>` : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="${viewBox}" role="img" aria-label="apart">${bg}${markShapes(theme, { outline })}</svg>`;
}

function textPath(font, text, x, baseline, size, tracking = 0) {
  const glyphs = font.stringToGlyphs(text);
  const scale = size / font.unitsPerEm;
  let cursor = x;
  const parts = [];
  glyphs.forEach((glyph, index) => {
    const outline = glyph.path.toPathData(1);
    if (outline) parts.push(`<path transform="translate(${cursor.toFixed(2)} ${baseline}) scale(${scale.toFixed(5)} ${(-scale).toFixed(5)})" d="${outline}"/>`);
    const next = glyphs[index + 1];
    const kern = next ? Number(font.getKerningValue(glyph, next)) || 0 : 0;
    cursor += (glyph.advanceWidth + kern) * scale + tracking * size;
  });
  return { svg: parts.join(""), width: cursor - x - (glyphs.length ? tracking * size : 0) };
}

function measure(font, text, size, tracking = 0) {
  return textPath(font, text, 0, 0, size, tracking).width;
}

function wordmarkSvg(theme, { height = 96 } = {}) {
  const t = THEMES[theme];
  const markSize = height;
  const fontSize = height * 0.78;
  const gap = height * 0.22;
  const baseline = height * 0.79;
  const word = textPath(bold, "apart", markSize + gap, baseline, fontSize, -0.02);
  const width = Math.ceil(markSize + gap + word.width + 2);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="apart">`
    + `<svg x="0" y="0" width="${markSize}" height="${markSize}" viewBox="8 8 112 112">${markShapes(theme)}</svg>`
    + `<g fill="${t.text}">${word.svg}</g></svg>`;
}

function headerSvg(theme) {
  const t = THEMES[theme];
  const width = 1280;
  const height = 320;
  const markSize = 120;
  const fontSize = 96;
  const gap = 28;
  const wordWidth = measure(bold, "apart", fontSize, -0.02);
  const groupWidth = markSize + gap + wordWidth;
  const left = (width - groupWidth) / 2;
  const word = textPath(bold, "apart", left + markSize + gap, 186, fontSize, -0.02);
  const tagline = "Your real browser, for your terminal agent.";
  const tagSize = 30;
  const tagWidth = measure(regular, tagline, tagSize);
  const tag = textPath(regular, tagline, (width - tagWidth) / 2, 262, tagSize);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="apart: your real browser, for your terminal agent">`
    + `<rect width="${width}" height="${height}" rx="24" fill="${t.bg}"/>`
    + `<svg x="${left}" y="${100}" width="${markSize}" height="${markSize}" viewBox="8 8 112 112">${markShapes(theme)}</svg>`
    + `<g fill="${t.text}">${word.svg}</g><g fill="${t.sub}">${tag.svg}</g></svg>`;
}

function socialSvg() {
  const t = THEMES.light;
  const width = 1280;
  const height = 640;
  const markSize = 168;
  const fontSize = 132;
  const gap = 36;
  const wordWidth = measure(bold, "apart", fontSize, -0.02);
  const left = (width - (markSize + gap + wordWidth)) / 2;
  const word = textPath(bold, "apart", left + markSize + gap, 336, fontSize, -0.02);
  const lines = ["Your real, signed-in browser,", "for your terminal agent."];
  const tagSize = 40;
  const tags = lines.map((line, i) => textPath(regular, line, (width - measure(regular, line, tagSize)) / 2, 440 + i * 54, tagSize));
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`
    + `<rect width="${width}" height="${height}" fill="${t.bg}"/>`
    + `<rect x="0" y="${height - 16}" width="${width}" height="16" fill="${C.berry}"/>`
    + `<svg x="${left}" y="${196}" width="${markSize}" height="${markSize}" viewBox="8 8 112 112">${markShapes("light")}</svg>`
    + `<g fill="${t.text}">${word.svg}</g><g fill="${t.sub}">${tags.map((tag) => tag.svg).join("")}</g></svg>`;
}

function promoSvg() {
  const width = 440;
  const height = 280;
  const markSize = 84;
  const fontSize = 64;
  const gap = 16;
  const wordWidth = measure(bold, "apart", fontSize, -0.02);
  const left = (width - (markSize + gap + wordWidth)) / 2;
  const word = textPath(bold, "apart", left + markSize + gap, 154, fontSize, -0.02);
  const line = "Your real browser, for your terminal agent.";
  const tagSize = 17;
  const tag = textPath(regular, line, (width - measure(regular, line, tagSize)) / 2, 204, tagSize);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`
    + `<rect width="${width}" height="${height}" fill="${C.paper}"/>`
    + `<rect x="0" y="${height - 10}" width="${width}" height="10" fill="${C.berry}"/>`
    + `<svg x="${left}" y="${84}" width="${markSize}" height="${markSize}" viewBox="8 8 112 112">${markShapes("light")}</svg>`
    + `<g fill="${C.ink}">${word.svg}</g><g fill="${C.muted}">${tag.svg}</g></svg>`;
}

function png(svg, width) {
  return new Resvg(svg, { fitTo: { mode: "width", value: width }, background: "rgba(0,0,0,0)" }).render().asPng();
}

function opaquePng(svg, width) {
  const image = new Resvg(svg, { fitTo: { mode: "width", value: width }, background: "#ffffff" }).render();
  const rows = Buffer.alloc(image.height * (image.width * 3 + 1));
  for (let y = 0; y < image.height; y++) {
    const row = y * (image.width * 3 + 1);
    for (let x = 0; x < image.width; x++) {
      image.pixels.copy(rows, row + 1 + x * 3, (y * image.width + x) * 4, (y * image.width + x) * 4 + 3);
    }
  }
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(image.width, 0);
  header.writeUInt32BE(image.height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

mkdirSync(BRAND_DIR, { recursive: true });
mkdirSync(ICON_DIR, { recursive: true });

for (const theme of ["light", "dark"]) {
  writeFileSync(path.join(BRAND_DIR, `mark-${theme}.svg`), markSvg(theme));
  writeFileSync(path.join(BRAND_DIR, `wordmark-${theme}.svg`), wordmarkSvg(theme));
  writeFileSync(path.join(BRAND_DIR, `header-${theme}.svg`), headerSvg(theme));
}
writeFileSync(path.join(BRAND_DIR, "mark-light.png"), png(markSvg("light", { size: 512 }), 512));
writeFileSync(path.join(BRAND_DIR, "social-preview.svg"), socialSvg());
writeFileSync(path.join(BRAND_DIR, "social-preview.png"), png(socialSvg(), 1280));
mkdirSync("design/store", { recursive: true });
writeFileSync("design/store/promo-tile-440x280.png", opaquePng(promoSvg(), 440));
writeFileSync("design/store/icon-128.png", png(markSvg("light", { size: 128, viewBox: "-8 -8 144 144" }), 128));

const ICONS = [
  { size: 16, viewBox: "6 6 116 116", outline: 6 },
  { size: 32, viewBox: "6 6 116 116", outline: 5 },
  { size: 48, viewBox: "0 0 128 128", outline: 4 },
  { size: 128, viewBox: "-8 -8 144 144", outline: 0 },
];
for (const icon of ICONS) {
  const svg = markSvg("light", { size: icon.size, viewBox: icon.viewBox, outline: icon.outline });
  writeFileSync(path.join(ICON_DIR, `icon-${icon.size}.png`), png(svg, icon.size));
}
writeFileSync(path.join(ICON_DIR, "mark.svg"), markSvg("light", { size: 64 }));
writeFileSync(path.join(ICON_DIR, "mark-dark.svg"), markSvg("dark", { size: 64 }));

console.log(`brand assets written to ${BRAND_DIR} and ${ICON_DIR}`);
