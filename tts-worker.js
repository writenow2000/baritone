// Baritone — neural speech worker. Runs Kokoro-82M (Apache-2.0) on-device
// via kokoro-js / transformers.js / ONNX Runtime Web. MIT License.
import { KokoroTTS, env } from "./vendor/kokoro.web.js";
import { respond } from "./audio-util.js";

// Serve the ONNX Runtime engine from this app (same origin, cached offline).
env.wasmPaths = new URL("./vendor/ort/", import.meta.url).href;

const MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";
const SR = 24000;
let tts = null;
let device = "wasm";
let epoch = 0;
let chain = Promise.resolve();

const post = (m, t) => self.postMessage(m, t || []);

async function load(want) {
  const files = new Map();
  const progress = (p) => {
    if (p.status === "progress" && p.total) {
      files.set(p.file, { loaded: p.loaded, total: p.total });
      let l = 0, t = 0;
      for (const f of files.values()) { l += f.loaded; t += f.total; }
      post({ type: "progress", loaded: l, total: t });
    }
  };
  if (want === "webgpu" && self.navigator?.gpu) {
    try {
      tts = await KokoroTTS.from_pretrained(MODEL_ID, { dtype: "fp32", device: "webgpu", progress_callback: progress });
      device = "webgpu";
      return;
    } catch (e) {
      post({ type: "note", text: "WebGPU unavailable, using CPU: " + (e?.message || e) });
    }
  }
  tts = await KokoroTTS.from_pretrained(MODEL_ID, { dtype: "q8", device: "wasm", progress_callback: progress });
  device = "wasm";
}

self.onmessage = (e) => {
  const m = e.data;
  if (m.type === "init") {
    chain = chain.then(async () => {
      try {
        await load(m.device);
        post({ type: "ready", device, isolated: self.crossOriginIsolated === true });
      } catch (err) {
        post({ type: "error", text: String(err?.message || err) });
      }
    });
  } else if (m.type === "cancel") {
    epoch = m.epoch;
  } else if (m.type === "gen") {
    chain = chain.then(async () => {
      if (m.epoch < epoch || !tts) return;
      try {
        post({ type: "start", id: m.id });
        const t0 = performance.now();
        const audio = await tts.generate(m.text, { voice: m.voice, speed: m.speed / m.depth });
        if (m.epoch < epoch) return post({ type: "skipped", id: m.id });
        await respond(post, m, audio.audio, SR, performance.now() - t0);
      } catch (err) {
        post({ type: "genError", id: m.id, epoch: m.epoch, text: String(err?.message || err) });
      }
    });
  }
};
