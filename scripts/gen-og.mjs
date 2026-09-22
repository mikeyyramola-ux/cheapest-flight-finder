/**
 * Generates social/app image assets with Playwright:
 *   client/public/og-image.png          1200x630 (Open Graph / Twitter card)
 *   client/public/icon-192.png          192x192  (web manifest)
 *   client/public/icon-512.png          512x512  (web manifest)
 *   client/public/apple-touch-icon.png  180x180  (iOS home screen)
 *   client/public/favicon.ico           32x32    (PNG-in-ICO for legacy requests)
 *
 * Run: node scripts/gen-og.mjs
 */
import { chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const outDir = path.resolve(import.meta.dirname, "../client/public");
fs.mkdirSync(outDir, { recursive: true });

// lucide "plane" glyph — same icon the site logo uses.
const PLANE = "M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z";

const shell = (inner, width, height) => `<!doctype html><html><head><meta charset="utf-8"><style>
  * { margin:0; padding:0; box-sizing:border-box; }
  html, body { width:${width}px; height:${height}px; overflow:hidden; }
  body { position:relative; background:#0d0e13; color:#f7f7f3;
         font-family:"Segoe UI", system-ui, -apple-system, Arial, sans-serif; }
  .glow-a { position:absolute; right:-16%; top:-48%; width:70%; height:120%;
            background:radial-gradient(circle, rgba(185,255,152,.15), transparent 60%); }
  .glow-b { position:absolute; left:-20%; bottom:-52%; width:62%; height:110%;
            background:radial-gradient(circle, rgba(147,121,255,.13), transparent 60%); }
  .mark { display:flex; align-items:center; justify-content:center; background:#b9ff98; border-radius:24%; }
</style></head><body><div class="glow-a"></div><div class="glow-b"></div>${inner}</body></html>`;

const ogInner = `
  <div style="position:relative; z-index:1; height:100%; padding:60px 68px; display:flex; flex-direction:column; justify-content:space-between;">
    <div style="display:flex; align-items:center; gap:18px;">
      <div class="mark" style="width:72px; height:72px;">
        <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="#10210d" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="${PLANE}"/></svg>
      </div>
      <div style="font-size:38px; font-weight:700; letter-spacing:-0.04em;">Fare<span style="color:#b9ff98;">loop</span></div>
    </div>
    <div>
      <div style="font-size:66px; font-weight:650; line-height:1.04; letter-spacing:-0.035em;">Catch the <span style="color:#b9ff98;">drop.</span><br/>Keep the trip.</div>
      <div style="margin-top:20px; font-size:23px; color:rgba(247,247,243,.55);">Compare cheap flights across 700+ airlines and get alerts when fares fall.</div>
    </div>
    <div style="display:flex; align-items:center; justify-content:space-between;">
      <div style="display:inline-flex; align-items:center; gap:10px; border:1px solid rgba(255,255,255,.14); background:rgba(255,255,255,.05); border-radius:999px; padding:11px 20px; font-size:17px; color:rgba(247,247,243,.75);">
        <span style="width:8px; height:8px; border-radius:50%; background:#b9ff98; box-shadow:0 0 8px #b9ff98;"></span>
        cheapest-flight-finder.vercel.app
      </div>
      <div style="display:flex; gap:12px; font-size:15px; font-weight:700;">
        <span style="border:1px solid rgba(185,255,152,.3); background:rgba(185,255,152,.08); color:#b9ff98; border-radius:999px; padding:10px 16px;">JFK → LHR · $418</span>
        <span style="border:1px solid rgba(255,255,255,.12); background:rgba(255,255,255,.04); color:rgba(247,247,243,.7); border-radius:999px; padding:10px 16px;">↓ 22% below avg.</span>
      </div>
    </div>
  </div>`;

const iconInner = `
  <div style="position:relative; z-index:1; height:100%; display:flex; align-items:center; justify-content:center;">
    <div class="mark" style="width:56%; height:56%;">
      <svg width="60%" height="60%" viewBox="0 0 24 24" fill="none" stroke="#10210d" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="${PLANE}"/></svg>
    </div>
  </div>`;

async function shot(browser, inner, width, height, file) {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  await page.setContent(shell(inner, width, height), { waitUntil: "load" });
  await page.screenshot({ path: path.join(outDir, file) });
  await page.close();
}

/** Wrap a 32x32 PNG in a minimal single-image ICO container (PNG-in-ICO). */
function pngToIco(png, size) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(1, 4); // count: 1
  const entry = Buffer.alloc(16);
  entry.writeUInt8(size >= 256 ? 0 : size, 0); // width
  entry.writeUInt8(size >= 256 ? 0 : size, 1); // height
  entry.writeUInt8(0, 2); // palette colors
  entry.writeUInt8(0, 3); // reserved
  entry.writeUInt16LE(1, 4); // color planes
  entry.writeUInt16LE(32, 6); // bits per pixel
  entry.writeUInt32LE(png.length, 8); // PNG data size
  entry.writeUInt32LE(22, 12); // offset (6 + 16)
  return Buffer.concat([header, entry, png]);
}

const browser = await chromium.launch();
try {
  await shot(browser, ogInner, 1200, 630, "og-image.png");
  await shot(browser, iconInner, 512, 512, "icon-512.png");
  await shot(browser, iconInner, 192, 192, "icon-192.png");
  await shot(browser, iconInner, 180, 180, "apple-touch-icon.png");

  const tmp32 = path.join(outDir, "__favicon32.png");
  await shot(browser, iconInner, 32, 32, "__favicon32.png");
  fs.writeFileSync(path.join(outDir, "favicon.ico"), pngToIco(fs.readFileSync(tmp32), 32));
  fs.unlinkSync(tmp32);

  console.log("og/app assets generated in", outDir);
} finally {
  await browser.close();
}
