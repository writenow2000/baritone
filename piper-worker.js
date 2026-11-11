// Baritone — fast neural speech worker. Runs a Piper voice (VITS, MIT-licensed
// voices from rhasspy/piper-voices) on-device with ONNX Runtime Web.
// Text → IPA with espeak-ng (the same phonemes Piper itself uses). MIT License.
import * as ort from "./vendor/ort-piper/ort.wasm.bundle.min.mjs";
import { phonemize } from "./vendor/phonemizer.js";
import { respond } from "./audio-util.js";

ort.env.wasm.wasmPaths = new URL("./vendor/ort-piper/", import.meta.url).href;
ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.max(1, Math.min(4, (self.navigator?.hardwareConcurrency || 2) - 1)) : 1;

const HF = "https://huggingface.co/rhasspy/piper-voices/resolve/main/";
const VOICES = {
  "en_US-ryan-medium": "en/en_US/ryan/medium/en_US-ryan-medium",
  "en_US-ryan-high": "en/en_US/ryan/high/en_US-ryan-high",
};

let session = null, config = null, voiceId = null, sr = 22050;
let epoch = 0;
let chain = Promise.resolve();
const post = (m, t) => self.postMessage(m, t || []);

// Download once, then keep in Cache Storage so it works offline.
async function fetchCached(url, onProgress) {
  let cache = null;
  try { cache = await caches.open("baritone-voices"); } catch {}
  if (cache) {
    const hit = await cache.match(url);
    if (hit) return new Uint8Array(await hit.arrayBuffer());
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Voice download failed (${res.status})`);
  const total = +res.headers.get("content-length") || 0;
  const reader = res.body.getReader();
  const chunks = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value); loaded += value.length;
    onProgress?.(loaded, total);
  }
  const out = new Uint8Array(loaded);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  if (cache) { try { await cache.put(url, new Response(out.slice(), { headers: { "content-type": "application/octet-stream" } })); } catch {} }
  return out;
}

async function load(id) {
  const path = VOICES[id];
  if (!path) throw new Error("Unknown voice " + id);
  const cfgBytes = await fetchCached(HF + path + ".onnx.json");
  config = JSON.parse(new TextDecoder().decode(cfgBytes));
  sr = config.audio?.sample_rate || 22050;
  const model = await fetchCached(HF + path + ".onnx", (loaded, total) => post({ type: "progress", loaded, total }));
  session = await ort.InferenceSession.create(model, { executionProviders: ["wasm"], graphOptimizationLevel: "all" });
  voiceId = id;
}

// Phonemize clause by clause, keeping the punctuation Piper uses for rhythm.
const PUNCT = new Set([",", ";", ":", ".", "!", "?", "—", "…"]);
async function toPhonemes(text) {
  const clauses = [];
  let buf = "";
  const chars = Array.from(text);
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    // A period/comma/colon between digits (15.3, 1,200, 8:30) is part of the number.
    const inNumber = (c === "." || c === "," || c === ":") && /\d/.test(chars[i - 1] || "") && /\d/.test(chars[i + 1] || "");
    if (PUNCT.has(c) && !inNumber) {
      let p = c === "—" ? ";" : c === "…" ? "." : c;
      while (PUNCT.has(chars[i + 1] || "")) i++; // collapse "?!" etc.
      clauses.push([buf, p]); buf = "";
    } else buf += c;
  }
  if (buf.trim()) clauses.push([buf, ""]);
  let out = "";
  for (const [body, p] of clauses) {
    const t = body.replace(/[‘’]/g, "'").replace(/["“”«»()[\]]/g, " ").trim();
    if (!t) { if (p && out) out = out.trimEnd() + p + " "; continue; }
    const ipa = (await phonemize(t, "en-us")).join(" ");
    out += ipa + p + " ";
  }
  return out.trim();
}

function toIds(ipa) {
  const map = config.phoneme_id_map;
  const ids = [...map["^"], ...map["_"]];
  for (const ch of Array.from(ipa)) {
    const v = map[ch];
    if (!v) continue;
    ids.push(...v, ...map["_"]);
  }
  ids.push(...map["$"]);
  return ids;
}

async function synth(text, speed) {
  const ipa = await toPhonemes(text);
  const ids = toIds(ipa);
  const inf = config.inference || {};
  const feeds = {
    input: new ort.Tensor("int64", BigInt64Array.from(ids.map(BigInt)), [1, ids.length]),
    input_lengths: new ort.Tensor("int64", BigInt64Array.from([BigInt(ids.length)]), [1]),
    scales: new ort.Tensor("float32", Float32Array.from([inf.noise_scale ?? 0.667, (inf.length_scale ?? 1) / speed, inf.noise_w ?? 0.8]), [3]),
  };
  if (session.inputNames.includes("sid")) feeds.sid = new ort.Tensor("int64", BigInt64Array.from([0n]), [1]);
  const out = await session.run(feeds);
  return out[session.outputNames[0]].data;
}

// Even out loudness between sentences (Piper's own player normalises the same way).
function gainFor(a) {
  let peak = 0;
  for (let i = 0; i < a.length; i++) { const v = Math.abs(a[i]); if (v > peak) peak = v; }
  return Math.min(3, 0.9 / Math.max(0.01, peak));
}

self.onmessage = (e) => {
  const m = e.data;
  if (m.type === "init") {
    chain = chain.then(async () => {
      try {
        await load(m.voice);
        post({ type: "ready", device: "piper", isolated: self.crossOriginIsolated === true, threads: ort.env.wasm.numThreads });
      } catch (err) {
        post({ type: "error", text: String(err?.message || err) });
      }
    });
  } else if (m.type === "cancel") {
    epoch = m.epoch;
  } else if (m.type === "gen") {
    chain = chain.then(async () => {
      if (m.epoch < epoch || !session) return;
      try {
        post({ type: "start", id: m.id });
        const t0 = performance.now();
        const audio = await synth(m.text, m.speed / m.depth);
        if (m.epoch < epoch) return post({ type: "skipped", id: m.id });
        await respond(post, m, audio, sr, performance.now() - t0, gainFor(audio));
      } catch (err) {
        post({ type: "genError", id: m.id, epoch: m.epoch, text: String(err?.message || err) });
      }
    });
  }
};
