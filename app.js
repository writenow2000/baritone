// Baritone — open-source neural PDF reader. MIT License.
import * as pdfjs from "./vendor/pdfjs/pdf.min.mjs";
import { ocrPage, stopOcr } from "./ocr.js";
import { stripCaptions, itemsToLines, stripRunningHeaders, linesToParagraphs, plainTextToParagraphs, buildChunks } from "./textproc.js";

pdfjs.GlobalWorkerOptions.workerSrc = new URL("./vendor/pdfjs/pdf.worker.min.mjs", import.meta.url).href;

const $ = (id) => document.getElementById(id);
const store = {
  get(k, d) { try { const v = localStorage.getItem("baritone." + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem("baritone." + k, JSON.stringify(v)); return true; } catch { return false; } },
};

// ---------- Settings ----------
const VOICE_NAMES = { am_michael: "Michael", am_fenrir: "Fenrir", am_onyx: "Onyx", am_puck: "Puck", am_eric: "Eric" };
const S = Object.assign(
  { voice: "am_michael", depth: 0.95, speed: 1.0, pause: 1, fontSize: 20, skipCite: true, skipUrl: true, skipCaptions: true, wake: true, engine: "wasm", prepMinutes: 20 },
  store.get("settings", {})
);
const saveSettings = () => store.set("settings", S);

// ---------- State ----------
let doc = null;            // { key, name, pages:[{num, paragraphs}] }
let chunks = [], paras = [];
let cur = 0, playing = false, waiting = -1, epoch = 0;
const cache = new Map();   // idx -> { url, seconds }
const requested = new Set();
const AHEAD_SECONDS = 50, AHEAD_MAX = 10;
let ready = false, loading = false, rtf = null, wakeLock = null, lastUserScroll = 0, previewing = false;

// ---------- Audio element (works with the iPhone silent switch & lock screen) ----------
const audio = new Audio();
audio.preload = "auto";
audio.setAttribute("playsinline", "");
try { if (navigator.audioSession) navigator.audioSession.type = "playback"; } catch {}
const SILENT = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA=";
let unlocked = false;
function unlockAudio() {
  if (unlocked) return;
  unlocked = true;
  audio.src = SILENT;
  audio.play().catch(() => {});
}

// ---------- Worker ----------
let worker = null;
let jobStartedAt = 0;      // when the engine began the sentence it's working on
let lastEngineMsg = 0;     // last sign of life while loading
let gpuWarm = false;       // first GPU sentence is slow (shader setup)
let strikes = 0;
function startWorker() {
  worker = new Worker(new URL("./tts-worker.js", import.meta.url), { type: "module" });
  worker.onmessage = onEngineMessage;
  worker.onerror = (e) => { console.warn("engine crashed", e.message); recover("crashed"); };
}
startWorker();

function onEngineMessage(e) {
  const m = e.data;
  lastEngineMsg = Date.now();
  if (m.type === "start") { jobStartedAt = Date.now(); return; }
  if (m.type === "audio" || m.type === "genError") { jobStartedAt = 0; if (m.type === "audio") gpuWarm = true; }
  if (m.type === "progress") {
    const pct = Math.round((m.loaded / m.total) * 100);
    status(`Downloading voice… ${pct}% (${(m.loaded / 1e6).toFixed(0)} of ${(m.total / 1e6).toFixed(0)} MB)`);
  } else if (m.type === "ready") {
    ready = true; loading = false; gpuWarm = m.device !== "webgpu";
    store.set("modelSeen", true);
    $("engineInfo").textContent = `Running on ${m.device === "webgpu" ? "GPU" : "CPU"}${m.isolated ? " (multi-threaded)" : ""}. Changing this reloads the voice.`;
    $("firstRun").hidden = true;
    status(prep ? "Preparing screen-off track…" : waiting >= 0 ? "Preparing voice…" : doc ? "Ready" : "Voice ready — open a PDF");
    pump();
    prepPump();
  } else if (m.type === "note") {
    console.warn(m.text);
  } else if (m.type === "error") {
    loading = false;
    status("Couldn't load the voice: " + m.text);
  } else if (m.type === "audio") {
    if (m.id === "preview") return playPreview(m);
    if (typeof m.id === "string" && m.id.startsWith("t:")) return onPrepAudio(m);
    if (m.epoch !== epoch) return;
    requested.delete(m.id);
    rtf = m.seconds / (m.ms / 1000);
    cache.set(m.id, { url: URL.createObjectURL(new Blob([m.buf], { type: "audio/wav" })), seconds: m.seconds });
    if (waiting === m.id && playing) startClip(m.id);
    pump();
  } else if (m.type === "genError") {
    if (typeof m.id === "string" && m.id.startsWith("t:")) return onPrepAudio(null, m);
    if (m.epoch !== epoch) return;
    requested.delete(m.id);
    console.warn("Skipping sentence", m.id, m.text);
    cache.set(m.id, { url: null, seconds: 0 });
    if (waiting === m.id && playing) advance();
    pump();
  }
}

// ---------- Watchdog: restart a frozen voice engine, fall back to CPU ----------
const WD = Number(new URLSearchParams(location.search).get("wd")) || 1; // time-limit scale (testing)
setInterval(() => {
  const now = Date.now();
  const gpu = S.engine === "webgpu";
  if (ready && jobStartedAt) {
    const limit = (gpu ? (gpuWarm ? 40e3 : 90e3) : 240e3) * WD;
    if (now - jobStartedAt > limit) recover("stopped responding");
  } else if (loading && lastEngineMsg && now - lastEngineMsg > 120e3) {
    recover("stopped responding while loading");
  }
}, 1000);

function recover(reason) {
  try { worker.terminate(); } catch {}
  strikes++;
  ready = false; loading = false; jobStartedAt = 0;
  let msg = "Voice engine " + reason + " — restarting it…";
  if (S.engine === "webgpu" && strikes >= 2) {
    S.engine = "wasm"; saveSettings();
    document.querySelectorAll("#engineSeg button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.v === "wasm")));
    msg = "GPU voice kept freezing — switched to CPU and continuing…";
  }
  // Work that was queued in the old engine is gone; queue it again.
  epoch++; requested.clear();
  if (prep) {
    prep.serial = ++prepSerial; prep.inflight = 0;
    prep.next = prep.ids.length ? prep.ids[prep.ids.length - 1] + 1 : prep.first;
  }
  if (previewing && $("previewBtn").textContent.startsWith("Generating")) { previewing = false; $("previewBtn").textContent = "▶︎ Preview this voice"; }
  startWorker();
  loadVoice();
  status(msg);
}

function loadVoice() {
  if (ready || loading) return;
  loading = true; lastEngineMsg = Date.now();
  status("Loading voice…");
  worker.postMessage({ type: "init", device: S.engine });
}

// ---------- Generation pipeline ----------
function pump() {
  if (!ready || !chunks.length || prep) return;
  let buffered = 0, count = 0;
  for (let i = cur; i < chunks.length && count < AHEAD_MAX; i++, count++) {
    const c = cache.get(i);
    if (c) { buffered += c.seconds; if (buffered > AHEAD_SECONDS) break; continue; }
    if (!requested.has(i)) {
      requested.add(i);
      const ch = chunks[i];
      worker.postMessage({ type: "gen", id: i, epoch, text: ch.spoken, voice: S.voice, speed: S.speed, depth: S.depth, pause: Math.round(ch.pause * S.pause) });
    }
    buffered += 4; // rough guess for queued-but-not-ready sentences
    if (buffered > AHEAD_SECONDS) break;
  }
  // free audio well behind the reading position
  for (const [i, c] of cache) if (i < cur - 3 || i > cur + 60) { if (c.url) URL.revokeObjectURL(c.url); cache.delete(i); }
}

function resetPipeline({ keepCache = false, except = -1 } = {}) {
  epoch++;
  worker.postMessage({ type: "cancel", epoch });
  requested.clear();
  if (!keepCache) {
    for (const [i, c] of cache) if (i !== except) { if (c.url) URL.revokeObjectURL(c.url); cache.delete(i); }
  }
}

// ---------- Playback ----------
function startClip(i) {
  const c = cache.get(i);
  waiting = -1;
  if (!c.url) return advance();
  audio.src = c.url;
  audio.play().then(() => status(statusLine())).catch((err) => { console.warn(err); setPlaying(false); status("Tap play to continue"); });
}

function goTo(i, { play = playing } = {}) {
  if (prep) cancelPrep();
  i = Math.max(0, Math.min(chunks.length - 1, i));
  if (track) {
    const k = track.ids.indexOf(i);
    if (k >= 0) {
      audio.currentTime = track.starts[k];
      cur = i; highlight(); savePos();
      if (play && audio.paused) { setPlaying(true); audio.play().catch(() => {}); }
      return;
    }
    exitTrack();
  }
  if (!cache.has(i) && !requested.has(i)) resetPipeline({ keepCache: true });
  cur = i;
  highlight();
  savePos();
  audio.pause();
  if (play) {
    setPlaying(true);
    if (cache.has(i)) startClip(i);
    else { waiting = i; status(ready ? "Preparing voice…" : "Loading voice…"); }
  }
  pump();
}

function advance() {
  if (cur >= chunks.length - 1) { setPlaying(false); status("Finished"); cur = chunks.length - 1; savePos(); return; }
  goTo(cur + 1, { play: true });
}

audio.addEventListener("ended", () => {
  if (track) return onTrackEnded();
  if (playing && !previewing && audio.src !== SILENT) advance();
});

function setPlaying(p) {
  playing = p;
  $("playBtn").setAttribute("aria-label", p ? "Pause" : "Play");
  $("playIcon").innerHTML = p ? '<path d="M6 4h4v16H6zM14 4h4v16h-4z"/>' : '<path d="M7 4.5v15l13-7.5z"/>';
  if ("mediaSession" in navigator) navigator.mediaSession.playbackState = p ? "playing" : "paused";
  if (p && S.wake) requestWake(); else releaseWake();
}

function togglePlay() {
  unlockAudio();
  if (!chunks.length) return openFile();
  if (!ready) loadVoice();
  if (playing) { audio.pause(); setPlaying(false); waiting = -1; status("Paused"); return; }
  if (track) { setPlaying(true); audio.play().catch(() => {}); status(statusLine()); return; }
  if (cur >= chunks.length - 1 && audio.ended) cur = 0;
  const resumable = audio.src && audio.src !== SILENT && !audio.ended && audio.currentTime > 0 && cache.get(cur)?.url === audio.src;
  if (resumable) { setPlaying(true); audio.play().catch(() => {}); status(statusLine()); }
  else goTo(cur, { play: true });
}

// ---------- Preview ----------
const PREVIEW = "Hello. This is how I'll read your documents: clearly, at a steady pace, with a short pause at each comma, and a longer one at the end of every sentence. Shall we begin?";
function preview() {
  unlockAudio();
  if (!ready) { loadVoice(); status("Loading voice… the preview will play when it's ready"); }
  previewing = true;
  audio.pause();
  setPlaying(false);
  worker.postMessage({ type: "gen", id: "preview", epoch: Number.MAX_SAFE_INTEGER, text: PREVIEW, voice: S.voice, speed: S.speed, depth: S.depth, pause: 0 });
  $("previewBtn").textContent = "Generating preview…";
}
function playPreview(m) {
  $("previewBtn").textContent = "▶︎ Preview this voice";
  audio.src = URL.createObjectURL(new Blob([m.buf], { type: "audio/wav" }));
  audio.play().catch(() => {});
  audio.addEventListener("ended", () => { previewing = false; }, { once: true });
}

// ---------- Screen-off listening: one continuous track ----------
// iOS keeps a single media track playing when the phone is locked, but pauses
// web-app code, so sentence-by-sentence playback can't continue. Here we render
// a stretch of reading ahead of time and join it into one WAV file.
let track = null; // { url, starts:[sec], ids:[chunkIndex], seconds }
let prep = null;  // in-progress preparation
let prepSerial = 0;

function startPrep(minutes) {
  if (!chunks.length) return;
  exitTrack();
  audio.pause(); setPlaying(false); waiting = -1;
  resetPipeline({ keepCache: true });
  prep = { serial: ++prepSerial, target: minutes * 60, parts: [], ids: [], starts: [], samples: 0,
    rate: Math.round(24000 * S.depth), next: cur, inflight: 0, t0: performance.now(), first: cur };
  requestWake();
  showPrepUI();
  if (!ready) { loadVoice(); $("prepText").textContent = "Loading voice…"; }
  prepPump();
}

function prepPump() {
  if (!prep || !ready) return;
  const doneSec = prep.samples / prep.rate;
  while (prep.inflight < 2 && prep.next < chunks.length && doneSec + prep.inflight * 5 < prep.target) {
    const i = prep.next++, ch = chunks[i];
    prep.inflight++;
    worker.postMessage({ type: "gen", raw: true, id: `t:${prep.serial}:${i}`, epoch, text: ch.spoken, voice: S.voice,
      speed: S.speed, depth: S.depth, pause: Math.round(ch.pause * S.pause) });
  }
  if (prep.inflight === 0) finishPrep();
}

function onPrepAudio(m, err) {
  const msg = m || err;
  const [, serial, idx] = msg.id.split(":");
  if (!prep || +serial !== prep.serial) return;
  prep.inflight--;
  if (m) {
    prep.starts.push(prep.samples / prep.rate);
    prep.ids.push(+idx);
    prep.parts.push(m.buf);
    prep.samples += m.buf.byteLength / 2;
    cur = +idx; highlight(); // follow along on screen while preparing
  }
  updatePrepUI();
  prepPump();
}

function finishPrep() {
  const p = prep; prep = null;
  if (!p || !p.parts.length) { showPrepUI(); return; }
  const header = new DataView(new ArrayBuffer(44));
  const str = (o, t) => { for (let i = 0; i < t.length; i++) header.setUint8(o + i, t.charCodeAt(i)); };
  str(0, "RIFF"); header.setUint32(4, 36 + p.samples * 2, true); str(8, "WAVE"); str(12, "fmt ");
  header.setUint32(16, 16, true); header.setUint16(20, 1, true); header.setUint16(22, 1, true);
  header.setUint32(24, p.rate, true); header.setUint32(28, p.rate * 2, true); header.setUint16(32, 2, true); header.setUint16(34, 16, true);
  str(36, "data"); header.setUint32(40, p.samples * 2, true);
  const blob = new Blob([header.buffer, ...p.parts], { type: "audio/wav" });
  p.parts.length = 0;
  track = { url: URL.createObjectURL(blob), starts: p.starts, ids: p.ids, seconds: p.samples / p.rate };
  try { $("screenoff").close(); } catch {}
  showPrepUI();
  cur = track.ids[0]; highlight();
  audio.src = track.url;
  setPlaying(true);
  audio.play().then(() => status(`Ready — ${fmt(track.seconds)} prepared. You can lock your phone now.`))
    .catch(() => { setPlaying(false); status(`${fmt(track.seconds)} prepared — tap play, then lock your phone`); });
}

function cancelPrep() {
  if (!prep) return;
  cur = prep.first; highlight();
  prep = null;
  resetPipeline({ keepCache: true });
  if (!playing) releaseWake();
  showPrepUI();
}

function exitTrack() {
  if (!track) return;
  audio.pause();
  URL.revokeObjectURL(track.url);
  track = null;
  try { navigator.mediaSession.setPositionState?.(); } catch {}
}

function onTrackEnded() {
  const last = track.ids[track.ids.length - 1];
  exitTrack();
  if (last >= chunks.length - 1) { setPlaying(false); cur = chunks.length - 1; highlight(); status("Finished"); return; }
  cur = last + 1; highlight(); savePos();
  if (document.visibilityState === "visible") goTo(cur, { play: true }); // screen on: carry on normally
  else { setPlaying(false); status("Prepared section finished — prepare more to keep listening"); }
}

let lastPos = 0;
audio.addEventListener("timeupdate", () => {
  if (!track) return;
  const t = audio.currentTime;
  let k = 0, lo = 0, hi = track.starts.length - 1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (track.starts[mid] <= t) { k = mid; lo = mid + 1; } else hi = mid - 1; }
  if (track.ids[k] !== cur) { cur = track.ids[k]; highlight(); savePos(); }
  if (Date.now() - lastPos > 1000) {
    lastPos = Date.now();
    if (playing) status(`${statusLine()} · ${fmt(track.seconds - t)} left in prepared track`);
    try { if (isFinite(audio.duration)) navigator.mediaSession?.setPositionState?.({ duration: audio.duration, position: Math.min(t, audio.duration), playbackRate: 1 }); } catch {}
  }
});

function fmt(sec) { sec = Math.max(0, Math.round(sec)); return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`; }

function showPrepUI() {
  $("prepSetup").hidden = !!prep;
  $("prepRun").hidden = !prep;
  if (prep) updatePrepUI();
  if (chunks.length) {
    const est = Math.round(chunks.slice(cur).reduce((a, c) => a + c.spoken.length, 0) / 900 / S.speed);
    $("lenHint").textContent = `About ${Math.max(1, est)} min of reading left from here. Keep Baritone open with the screen on while it prepares; it starts playing automatically.`;
  }
}

function updatePrepUI() {
  if (!prep) return;
  const done = prep.samples / prep.rate;
  const goal = Math.min(prep.target, done + chunks.slice(prep.next).reduce((a, c) => a + c.spoken.length, 0) / 15 / S.speed);
  const frac = Math.min(1, done / Math.max(1, goal));
  $("prepBar").style.width = (frac * 100).toFixed(1) + "%";
  $("prepText").textContent = `Prepared ${fmt(done)} of ${fmt(goal)}`;
  const elapsed = (performance.now() - prep.t0) / 1000;
  if (done > 5) $("prepEta").textContent = `About ${Math.max(1, Math.round(((goal - done) * elapsed) / done / 60))} min to go`;
  status(`Preparing screen-off track… ${Math.round(frac * 100)}%`);
}

// ---------- Rendering ----------
function render() {
  const r = $("reader");
  r.innerHTML = "";
  const frag = document.createDocumentFragment();
  let lastPage = -1, el = null, curPara = -1;
  chunks.forEach((c, i) => {
    if (c.page !== lastPage && (doc.pages.length > 1)) {
      const d = document.createElement("div"); d.className = "pg"; d.id = "page-" + c.page; d.textContent = "Page " + c.page;
      frag.appendChild(d); lastPage = c.page;
    }
    if (c.para !== curPara) { el = document.createElement(c.heading ? "h2" : "p"); frag.appendChild(el); curPara = c.para; }
    else el.appendChild(document.createTextNode(" "));
    const s = document.createElement("span"); s.className = "s"; s.dataset.i = i; s.textContent = c.display;
    el.appendChild(s);
  });
  r.appendChild(frag);
  r.hidden = false; $("empty").hidden = true;
  $("pagesBtn").hidden = doc.pages.length < 2;
  $("lockBtn").hidden = false;
  $("docTitle").textContent = doc.name;
  const sel = $("pageSel"); sel.innerHTML = "";
  const seen = new Set();
  chunks.forEach((c, i) => { if (!seen.has(c.page)) { seen.add(c.page); sel.add(new Option("Page " + c.page, i)); } });
  highlight(true);
}

let curEl = null;
function highlight(force) {
  if (curEl) curEl.classList.remove("cur");
  curEl = $("reader").querySelector(`.s[data-i="${cur}"]`);
  if (curEl) {
    curEl.classList.add("cur");
    const rect = curEl.getBoundingClientRect(), mainR = $("main").getBoundingClientRect();
    const visible = rect.top > mainR.top + 60 && rect.bottom < window.innerHeight - 190;
    if (force || (!visible && Date.now() - lastUserScroll > 4000)) curEl.scrollIntoView({ block: "center", behavior: force ? "auto" : "smooth" });
  }
  $("progress").style.width = chunks.length ? ((cur / Math.max(1, chunks.length - 1)) * 100).toFixed(1) + "%" : "0";
  updateMediaSession();
  if (!playing && chunks.length) status(statusLine());
}

function statusLine() {
  if (!chunks.length) return "";
  const pct = Math.round((cur / Math.max(1, chunks.length - 1)) * 100);
  const pageCount = doc.pages.length;
  return pageCount > 1 ? `Page ${chunks[cur].page} of ${pageCount} · ${pct}%` : `${pct}%`;
}
function status(t) { $("status").textContent = t; }

// ---------- Opening documents ----------
function openFile() { unlockAudio(); loadVoice(); $("file").click(); }

$("file").addEventListener("change", async (e) => {
  const f = e.target.files[0];
  e.target.value = "";
  if (!f) return;
  busy("Reading PDF…");
  try {
    const data = new Uint8Array(await f.arrayBuffer());
    const pdf = await pdfjs.getDocument({ data, isEvalSupported: false }).promise;
    const pagesLines = [];
    let ocrUsed = false;
    const t0 = performance.now();
    for (let p = 1; p <= pdf.numPages; p++) {
      const page = await pdf.getPage(p);
      const tc = await page.getTextContent();
      let lines = itemsToLines(tc.items);
      // No real text on this page (scan, or letters drawn as shapes): recognise it.
      if (lines.reduce((a, l) => a + l.text.length, 0) < 20) {
        if (!ocrUsed) { ocrUsed = true; }
        const left = p > 1 && ocrUsed ? Math.round(((performance.now() - t0) / (p - 1)) * (pdf.numPages - p + 1) / 60000) : 0;
        busy(`This PDF is made of images, so Baritone is reading the text from them — page ${p} of ${pdf.numPages}${left > 0 ? ` (about ${left} min left)` : ""}…`);
        try { lines = await ocrPage(page); } catch (err) { console.warn("OCR failed on page", p, err); lines = []; }
      } else {
        busy(`Reading page ${p} of ${pdf.numPages}…`);
      }
      pagesLines.push(lines);
      page.cleanup();
    }
    if (ocrUsed) stopOcr();
    const cleaned = stripRunningHeaders(pagesLines);
    const pages = cleaned.map((lines, i) => ({ num: i + 1, paragraphs: linesToParagraphs(lines) }));
    mergeAcrossPages(pages);
    let title = f.name.replace(/\.pdf$/i, "");
    try { const meta = await pdf.getMetadata(); const t = (meta?.info?.Title || "").replace(/^Microsoft (Word|PowerPoint) - /, "").replace(/\s+[-–|]\s+(Instapaper|Pocket|Medium)$/i, "").trim(); if (t.length > 3 && !/^\(?(anonymous|untitled)\)?$/i.test(t) && !/\.(docx?|pptx?)$/i.test(t)) title = t; } catch {}
    await pdf.destroy();
    if (!pages.some((p) => p.paragraphs.length)) {
      busy(false);
      status("Couldn't find any readable text in this PDF.");
      return;
    }
    loadDoc({ key: f.name + ":" + f.size, name: title, pages });
  } catch (err) {
    console.error(err);
    status("Couldn't read that PDF: " + (err?.message || err));
  } finally { busy(false); }
});

// A sentence that continues onto the next page shouldn't get a paragraph pause.
function mergeAcrossPages(pages) {
  for (let i = 0; i < pages.length - 1; i++) {
    const a = pages[i].paragraphs, b = pages[i + 1].paragraphs;
    if (!a.length || !b.length) continue;
    const last = a[a.length - 1], first = b[0];
    const continues = /^[a-z,;)]/.test(first.text) || (!/[.!?:"”’)…]$/.test(last.text) && /^[A-Za-z(]/.test(first.text));
    if (!last.heading && !first.heading && continues) {
      last.text = /[A-Za-z]-$/.test(last.text) ? last.text.slice(0, -1) + first.text : last.text + " " + first.text;
      b.shift();
    }
  }
}

function loadDoc(d, restore = false) {
  cancelPrep(); exitTrack();
  resetPipeline();
  audio.pause(); setPlaying(false);
  doc = d;
  ({ chunks, paras } = buildChunks(readablePages(), { skipCitations: S.skipCite, skipUrls: S.skipUrl }));
  const pos = store.get("pos", {})[doc.key] || 0;
  cur = Math.min(pos, chunks.length - 1);
  render();
  if (!restore || !store.get("lastDoc")) store.set("lastDoc", doc) || store.set("lastDoc", null);
  status(pos > 0 ? `Resuming — ${statusLine()}` : statusLine());
  pump();
}

function readablePages() {
  const pages = doc.pages.map((p) => ({ ...p, paragraphs: p.paragraphs.map((q) => ({ ...q })) }));
  return S.skipCaptions ? stripCaptions(pages) : pages;
}

function rebuild() { // settings that change the spoken text
  if (!doc) return;
  const keep = cur;
  ({ chunks, paras } = buildChunks(readablePages(), { skipCitations: S.skipCite, skipUrls: S.skipUrl }));
  cur = Math.min(keep, chunks.length - 1);
  resetPipeline(); render(); if (playing) goTo(cur, { play: true }); else pump();
}

let posTimer = null;
function savePos() {
  if (!doc) return;
  clearTimeout(posTimer);
  posTimer = setTimeout(() => { const p = store.get("pos", {}); p[doc.key] = cur; store.set("pos", p); }, 300);
}

// ---------- Media Session (lock screen / AirPods controls) ----------
function updateMediaSession() {
  if (!("mediaSession" in navigator) || !doc) return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: doc.name, artist: `Baritone · ${VOICE_NAMES[S.voice]}`,
      album: doc.pages.length > 1 ? `Page ${chunks[cur]?.page}` : "",
      artwork: [{ src: "icons/icon-512.png", sizes: "512x512", type: "image/png" }],
    });
  } catch {}
}
if ("mediaSession" in navigator) {
  const ms = navigator.mediaSession;
  const h = (a, f) => { try { ms.setActionHandler(a, f); } catch {} };
  h("play", () => { if (!playing) togglePlay(); });
  h("pause", () => { if (playing) togglePlay(); });
  h("nexttrack", () => goTo(cur + 1));
  h("previoustrack", () => goTo(cur - 1));
  h("seekforward", () => goTo(nextParaStart()));
  h("seekbackward", () => goTo(paraStart()));
  h("seekto", (d) => { if (track && d.seekTime != null) { audio.currentTime = d.seekTime; } });
}
const paraStart = () => { const p = paras[chunks[cur]?.para]; return p && cur > p.first ? p.first : (paras[chunks[cur]?.para - 1]?.first ?? 0); };
const nextParaStart = () => paras[chunks[cur]?.para + 1]?.first ?? chunks.length - 1;

// ---------- Wake lock ----------
async function requestWake() { try { if (!wakeLock && navigator.wakeLock) { wakeLock = await navigator.wakeLock.request("screen"); wakeLock.addEventListener("release", () => (wakeLock = null)); } } catch {} }
function releaseWake() { try { wakeLock?.release(); } catch {} wakeLock = null; }
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && playing && S.wake) requestWake(); });

// ---------- UI wiring ----------
function busy(t) { $("busy").style.display = t ? "grid" : "none"; if (t) $("busyText").textContent = t; }
$("openBtn").onclick = openFile;
$("openBig").onclick = openFile;
$("playBtn").onclick = togglePlay;
$("prevBtn").onclick = () => { unlockAudio(); goTo(cur - 1); };
$("nextBtn").onclick = () => { unlockAudio(); goTo(cur + 1); };
$("reader").addEventListener("click", (e) => {
  const s = e.target.closest(".s"); if (!s) return;
  unlockAudio(); if (!ready) loadVoice();
  goTo(+s.dataset.i, { play: true });
});
$("main").addEventListener("touchmove", () => (lastUserScroll = Date.now()), { passive: true });
$("main").addEventListener("wheel", () => (lastUserScroll = Date.now()), { passive: true });

document.querySelectorAll("dialog").forEach((d) => {
  d.addEventListener("click", (e) => { if (e.target === d || e.target.closest("[data-close]")) d.close(); });
});
$("settingsBtn").onclick = () => $("settings").showModal();
$("voiceChip").onclick = () => $("settings").showModal();
$("pagesBtn").onclick = () => { $("pageSel").value = [...$("pageSel").options].filter((o) => +o.value <= cur).pop()?.value ?? 0; $("pages").showModal(); };
$("pageSel").onchange = (e) => { goTo(+e.target.value); $("pages").close(); };
$("lockBtn").onclick = () => { unlockAudio(); loadVoice(); showPrepUI(); $("screenoff").showModal(); };
$("prepGo").onclick = () => { unlockAudio(); startPrep(S.prepMinutes); };
$("prepCancel").onclick = () => { cancelPrep(); status("Preparation cancelled"); };
$("restartBtn").onclick = () => { goTo(0); $("pages").close(); };
$("pasteBtn").onclick = () => { unlockAudio(); loadVoice(); $("paste").showModal(); };
$("pasteGo").onclick = () => {
  const t = $("pasteText").value.trim(); if (!t) return;
  $("paste").close();
  loadDoc({ key: "paste:" + t.length + ":" + t.slice(0, 40), name: "Pasted text", pages: [{ num: 1, paragraphs: plainTextToParagraphs(t) }] });
};

const SPEEDS = [0.8, 0.9, 1.0, 1.1, 1.2, 1.3];
$("speedChip").onclick = () => {
  const i = SPEEDS.findIndex((s) => s >= S.speed - 0.001);
  setSetting("speed", SPEEDS[(i + 1) % SPEEDS.length]);
};

function seg(id, key, parse = Number) {
  const el = $(id);
  const sync = () => el.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(parse(b.dataset.v) === S[key])));
  el.addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) { setSetting(key, parse(b.dataset.v)); sync(); } });
  sync();
}
seg("depthSeg", "depth");
seg("pauseSeg", "pause");
seg("engineSeg", "engine", String);
seg("lenSeg", "prepMinutes");
$("voiceSel").value = S.voice;
$("voiceSel").onchange = (e) => setSetting("voice", e.target.value);
$("speed").value = S.speed;
$("speed").oninput = (e) => setSetting("speed", +(+e.target.value).toFixed(2));
$("fontSize").value = S.fontSize;
$("fontSize").oninput = (e) => setSetting("fontSize", +e.target.value);
for (const k of ["skipCite", "skipUrl", "skipCaptions", "wake"]) { $(k).checked = S[k]; $(k).onchange = (e) => setSetting(k, e.target.checked); }
$("previewBtn").onclick = preview;

function setSetting(k, v) {
  if (S[k] === v) return;
  if (prep && ["voice", "depth", "speed", "pause", "skipCite", "skipUrl", "skipCaptions"].includes(k)) { cancelPrep(); status("Settings changed — tap Prepare again"); }
  S[k] = v; saveSettings(); applyUI();
  if (["voice", "depth", "speed", "pause"].includes(k)) {
    // keep the sentence that's playing; regenerate from the next one
    resetPipeline({ except: playing ? cur : -1 });
    pump();
  } else if (k === "skipCite" || k === "skipUrl" || k === "skipCaptions") rebuild();
  else if (k === "engine") { store.set("settings", S); location.reload(); }
  else if (k === "wake") { if (v && playing) requestWake(); else releaseWake(); }
}
function applyUI() {
  $("speedChip").textContent = S.speed.toFixed(S.speed * 10 % 1 ? 2 : 1) + "×";
  $("speedVal").textContent = S.speed.toFixed(2) + "×";
  $("speed").value = S.speed;
  $("voiceChip").textContent = VOICE_NAMES[S.voice] || "Voice";
  document.documentElement.style.setProperty("--fs", S.fontSize + "px");
  updateMediaSession();
}
applyUI();

// ---------- Startup ----------
const last = store.get("lastDoc");
if (last?.pages) loadDoc(last, true);
if (store.get("modelSeen", false)) loadVoice(); // already downloaded before → warm up silently

// Offline support + cross-origin isolation (enables multi-threaded speech engine).
if ("serviceWorker" in navigator && location.protocol !== "file:") {
  navigator.serviceWorker.register("sw.js").then(() => {
    if (!crossOriginIsolated && navigator.serviceWorker.controller === null) {
      navigator.serviceWorker.ready.then(() => {
        if (!sessionStorage.getItem("baritone.reloaded")) { sessionStorage.setItem("baritone.reloaded", "1"); location.reload(); }
      });
    }
  }).catch((e) => console.warn("SW", e));
}
