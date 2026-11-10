// Baritone — on-device OCR for PDFs whose pages are pictures or drawn shapes
// rather than real text. Uses Tesseract.js (Apache-2.0), fully local. MIT License.
import Tesseract from "./vendor/tesseract/tesseract.esm.min.js";

let worker = null;
const base = (p) => new URL(p, import.meta.url).href;

async function getWorker() {
  if (worker) return worker;
  worker = await Tesseract.createWorker("eng", 1, {
    workerPath: base("./vendor/tesseract/worker.min.js"),
    corePath: base("./vendor/tesseract/core/"),
    langPath: base("./vendor/tesseract/lang"),
    gzip: true,
    cacheMethod: "none",
    workerBlobURL: false,
  });
  return worker;
}

const AFTER_I = "was|had|have|am|felt|thought|think|love|loved|laid|saw|knew|walked|met|began|stood|realized|remember|remembered|could|would|did|didn't|wasn't|wanted|went|got|found|said|asked|told|came|took|stopped|passed|arrived|sat|left|liked|lay|looked|heard|noticed|tried|made|bristled|believe|guess|mean|know|need|will|can";
const AFTER_A = "view|version|section|path|walk|town|man|woman|few|lot|long|short|small|large|little|new|good|day|week|year|fellow|pair|group|series|number|mile|minute";
const FIXES = [
  [new RegExp(`\\bI['’]?(${AFTER_I})\\b`, "g"), "I $1"],          // "Iwas", "I'think" → "I was", "I think"
  [new RegExp(`\\bT(${AFTER_I.replace("|have|", "|")})\\b`, "g"), "I $1"], // "Thad", "Tloved" → "I had", "I loved"
  [new RegExp(`\\bA(${AFTER_A})\\b`, "g"), "A $1"],              // "Aview" → "A view"
  [/(^|[.!?]["”’]?\s+)1(?=,? [a-z])/g, "$1I"],                      // "1, for my part" → "I, for my part"
  [/\bl(?=[’'](m|ve|ll|d)\b)/g, "I"],                               // "l'm" → "I'm"
];
export function fixOcrText(t) { for (const [re, rep] of FIXES) t = t.replace(re, rep); return t; }

export async function stopOcr() {
  if (worker) { try { await worker.terminate(); } catch {} worker = null; }
}

/** Render a pdf.js page and recognise its text.
 *  Returns lines in the same shape as itemsToLines() so the normal
 *  paragraph/heading logic applies. */
export async function ocrPage(page) {
  const viewport = page.getViewport({ scale: 2 });
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport }).promise;

  const w = await getWorker();
  const { data } = await w.recognize(canvas, {}, { blocks: true, text: false });
  canvas.width = canvas.height = 0; // free memory on iPhone

  const lines = [];
  for (const b of data.blocks || []) {
    for (const p of b.paragraphs || []) {
      for (const l of p.lines || []) {
        const text = fixOcrText((l.text || "").replace(/\s+/g, " ").trim());
        if (!text) continue;
        const letters = (text.match(/[A-Za-z]/g) || []).length;
        // Photos and decorations produce low-confidence or symbol-heavy noise.
        if (l.confidence < 55 || letters < Math.max(2, text.length * 0.5)) continue;
        // Use x-height-ish size from the words so descenders don't inflate it.
        const hs = (l.words || []).map((wd) => wd.bbox.y1 - wd.bbox.y0).sort((a, c) => a - c);
        const h = hs.length ? hs[Math.floor(hs.length / 2)] : l.bbox.y1 - l.bbox.y0;
        lines.push({ text, x: l.bbox.x0, right: l.bbox.x1, y: -l.bbox.y1, h, conf: l.confidence, ocr: true });
      }
    }
  }
  return lines;
}
