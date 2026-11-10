# Baritone — open-source neural PDF reader for iPhone

Baritone reads PDFs aloud in a deep, clear American male voice. It's a web app you install
on your iPhone's Home Screen. The neural voice (**Kokoro-82M**) runs **entirely on the phone**:
your documents are never uploaded, and once the voice has downloaded it works offline.

## Features
- **Open any text PDF** (Files, iCloud Drive, Downloads), or paste text.
- **Deep American male voices:** Michael (default), Fenrir, Onyx, Puck and Eric, plus a **Depth** control
  (Natural / Deep / Deeper / Deepest) that lowers the pitch without changing the speed.
- **Clear pronunciation:** abbreviations are expanded (e.g. → "for example", Fig. 3 → "Figure 3", 45% → "45 percent",
  Jan. → "January"); words hyphenated across lines are rejoined; running headers, footers and page numbers are removed;
  citation numbers like [12] and web addresses are skipped (you can turn this off).
- **Punctuation-aware pauses:** each comma split, semicolon/colon, sentence end, question, paragraph and heading
  gets its own pause, and the model's own silence is trimmed so the pauses stay consistent.
  Short / Normal / Long pause settings are available.
- **Screen-off listening:** prepares up to 30 minutes as one continuous track that keeps playing when the phone is locked.
- Highlights the sentence being read. **Tap any sentence** to start reading from it. Use **Go to page** to jump.
- Remembers your place in each document. Lock-screen and AirPods controls (next/previous sentence).
- Speed 0.7×–1.5×, text size, dark mode, and a "keep screen on" option.

## Put it on your iPhone (about 5 minutes, free)
The app has to be served over HTTPS. The easiest free host is **GitHub Pages**:

1. Sign in at github.com (or create a free account) and create a **new public repository**, e.g. `baritone`.
2. Click **"uploading an existing file"**, then drag in **everything inside this folder**, keeping the `vendor/`
   and `icons/` folders. Commit.
3. Go to **Settings → Pages**. Under "Build and deployment", choose **Deploy from a branch** → `main` / `(root)` → Save.
4. After about a minute your app is live at `https://YOUR-NAME.github.io/baritone/`.
5. On the iPhone, open that address in **Safari**, tap **Share → Add to Home Screen**.
6. Open **Baritone** from the Home Screen. The first time you play something, the voice model (~90 MB) downloads
   once; after that it starts quickly and works offline.

Other hosts also work: Netlify (drag the folder onto app.netlify.com/drop), Cloudflare Pages, or any HTTPS server.

### Run it on a computer
```
cd baritone
python3 -m http.server 8000
```
then open http://localhost:8000.

## Tips
- **iPhone silent switch:** Baritone uses media playback, so it plays even when the ring/silent switch is on silent.
- **Listening with the screen locked:** tap the **padlock** button, choose 10, 20 or 30 minutes, and tap **Prepare**.
  Baritone renders that stretch as one continuous track, then starts playing it. Once it's playing you can lock
  the phone or switch apps; the lock-screen and AirPods controls skip sentences and let you scrub. Keep Baritone
  open with the screen on while it prepares (roughly 1 minute of preparing per 2–4 minutes of audio on a recent
  iPhone). When the track ends, prepare the next stretch.
- **Normal mode** (the play button) reads sentence by sentence and needs the app open with the screen on.
  iOS pauses web apps in the background. "Keep screen on" is enabled by default for this.
- **Speed of the voice engine:** recent iPhones generate speech faster than real time on the CPU engine. If you hear
  "Preparing voice…" gaps on an older phone, try the **GPU** engine in settings (iOS 26 or later; larger download).
- **Scanned PDFs** (pictures of pages) have no text to read. Run them through an OCR app first.

## How it works
| Part | What it does | License |
|---|---|---|
| `app.js` | UI, playback queue, media session, saved position | MIT |
| `textproc.js` | PDF line/paragraph rebuilding, cleanup, sentence splitting, pause planning | MIT |
| `tts-worker.js` | Runs Kokoro in a Web Worker, trims silence, applies depth, adds pauses, encodes WAV | MIT |
| `sw.js` | Offline cache and cross-origin isolation (enables multi-threaded speech) | MIT |
| `vendor/kokoro.web.js` | [kokoro-js](https://github.com/hexgrad/kokoro) 1.2.1 (bundles transformers.js) | Apache-2.0 |
| `vendor/ort/` | ONNX Runtime Web engine | MIT |
| `vendor/pdfjs/` | [pdf.js](https://mozilla.github.io/pdf.js/) 4.10.38 | Apache-2.0 |
| Voice model | [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M), fetched once from Hugging Face | Apache-2.0 |

Depth works by playing each clip at a slightly lower sample rate, which lowers the pitch. The text is generated
proportionally faster first, so the reading speed stays the same.

## Customizing
- Pause lengths: `PAUSES` in `textproc.js`.
- Words to expand: the `SPOKEN` list in `textproc.js`.
- Default voice and settings: the `S` object near the top of `app.js`.
- After changing files on your host, bump `VERSION` in `sw.js` so phones pick up the update.
