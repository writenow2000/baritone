// Baritone — neural speech worker. Runs Kokoro-82M (Apache-2.0) on-device
// via kokoro-js / transformers.js / ONNX Runtime Web. MIT License.
import { KokoroTTS, env } from "./vendor/kokoro.web.js";

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

// Trim the model's own leading/trailing silence so our punctuation pauses are exact.
function trim(a) {
  const thr = 0.006, pad = Math.round(SR * 0.025);
  let s = 0, e = a.length - 1;
  while (s < e && Math.abs(a[s]) < thr) s++;
  while (e > s && Math.abs(a[e]) < thr) e--;
  return a.subarray(Math.max(0, s - pad), Math.min(a.length, e + pad));
}

// 16-bit PCM with a short lead-in and the punctuation pause as trailing silence.
// "depth" plays the clip back at a slightly lower sample rate, which deepens the
// voice; tempo is pre-compensated by generating faster.
function pcm(samples, pauseMs, depth) {
  const rate = Math.round(SR * depth);
  const lead = Math.round(rate * 0.02);
  const tail = Math.round((rate * pauseMs) / 1000);
  const out = new Int16Array(lead + samples.length + tail);
  const fade = Math.round(SR * 0.004); // 4 ms fades avoid clicks
  for (let i = 0; i < samples.length; i++) {
    let x = samples[i];
    if (i < fade) x *= i / fade;
    else if (i > samples.length - fade) x *= (samples.length - i) / fade;
    x = Math.max(-1, Math.min(1, x * 0.95));
    out[lead + i] = x < 0 ? x * 0x8000 : x * 0x7fff;
  }
  return { out, rate };
}

function wavHeader(numSamples, rate) {
  const v = new DataView(new ArrayBuffer(44));
  const str = (o, t) => { for (let i = 0; i < t.length; i++) v.setUint8(o + i, t.charCodeAt(i)); };
  str(0, "RIFF"); v.setUint32(4, 36 + numSamples * 2, true); str(8, "WAVE"); str(12, "fmt ");
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, "data"); v.setUint32(40, numSamples * 2, true);
  return v.buffer;
}

function wav(samples, pauseMs, depth) {
  const { out, rate } = pcm(samples, pauseMs, depth);
  const buf = new Uint8Array(44 + out.byteLength);
  buf.set(new Uint8Array(wavHeader(out.length, rate)), 0);
  buf.set(new Uint8Array(out.buffer), 44);
  return { buf: buf.buffer, seconds: out.length / rate };
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
        const t0 = performance.now();
        const audio = await tts.generate(m.text, { voice: m.voice, speed: m.speed / m.depth });
        if (m.epoch < epoch) return;
        if (m.raw) {
          const { out, rate } = pcm(trim(audio.audio), m.pause, m.depth);
          post({ type: "audio", id: m.id, epoch: m.epoch, buf: out.buffer, rate, seconds: out.length / rate, ms: performance.now() - t0 }, [out.buffer]);
        } else {
          const { buf, seconds } = wav(trim(audio.audio), m.pause, m.depth);
          post({ type: "audio", id: m.id, epoch: m.epoch, buf, seconds, ms: performance.now() - t0 }, [buf]);
        }
      } catch (err) {
        post({ type: "genError", id: m.id, epoch: m.epoch, text: String(err?.message || err) });
      }
    });
  }
};
