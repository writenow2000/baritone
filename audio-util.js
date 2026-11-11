// Baritone — shared audio helpers for the voice engines. MIT License.

// Trim the model's own leading/trailing silence so punctuation pauses are exact.
export function trim(a, sr) {
  const thr = 0.006, pad = Math.round(sr * 0.025);
  let s = 0, e = a.length - 1;
  while (s < e && Math.abs(a[s]) < thr) s++;
  while (e > s && Math.abs(a[e]) < thr) e--;
  return a.subarray(Math.max(0, s - pad), Math.min(a.length, e + pad));
}

// 16-bit PCM with a short lead-in and the punctuation pause as trailing silence.
// "depth" plays the clip back at a slightly lower sample rate, which deepens the
// voice; tempo is pre-compensated by generating faster. "gain" scales loudness.
export function pcm(samples, pauseMs, depth, sr, gain = 0.95) {
  const rate = Math.round(sr * depth);
  const lead = Math.round(rate * 0.02);
  const tail = Math.round((rate * pauseMs) / 1000);
  const out = new Int16Array(lead + samples.length + tail);
  const fade = Math.round(sr * 0.004); // 4 ms fades avoid clicks
  for (let i = 0; i < samples.length; i++) {
    let x = samples[i] * gain;
    if (i < fade) x *= i / fade;
    else if (i > samples.length - fade) x *= (samples.length - i) / fade;
    x = Math.max(-1, Math.min(1, x));
    out[lead + i] = x < 0 ? x * 0x8000 : x * 0x7fff;
  }
  return { out, rate };
}

export function wavHeader(numSamples, rate) {
  const v = new DataView(new ArrayBuffer(44));
  const str = (o, t) => { for (let i = 0; i < t.length; i++) v.setUint8(o + i, t.charCodeAt(i)); };
  str(0, "RIFF"); v.setUint32(4, 36 + numSamples * 2, true); str(8, "WAVE"); str(12, "fmt ");
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, "data"); v.setUint32(40, numSamples * 2, true);
  return v.buffer;
}

export function wav(samples, pauseMs, depth, sr, gain) {
  const { out, rate } = pcm(samples, pauseMs, depth, sr, gain);
  const buf = new Uint8Array(44 + out.byteLength);
  buf.set(new Uint8Array(wavHeader(out.length, rate)), 0);
  buf.set(new Uint8Array(out.buffer), 44);
  return { buf: buf.buffer, seconds: out.length / rate };
}

/** Run one generation request and post the result in the format the app expects. */
export async function respond(post, m, samples, sr, ms, gain) {
  const t = trim(samples, sr);
  if (m.raw) {
    const { out, rate } = pcm(t, m.pause, m.depth, sr, gain);
    post({ type: "audio", id: m.id, epoch: m.epoch, buf: out.buffer, rate, seconds: out.length / rate, ms }, [out.buffer]);
  } else {
    const { buf, seconds } = wav(t, m.pause, m.depth, sr, gain);
    post({ type: "audio", id: m.id, epoch: m.epoch, buf, seconds, ms }, [buf]);
  }
}
