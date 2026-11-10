// Baritone — text processing: PDF text reconstruction, cleanup for speech,
// sentence splitting and punctuation-aware pause planning.
// MIT License.

// ---------- Pause plan (milliseconds at "Normal") ----------
export const PAUSES = {
  comma: 150,      // used only when a very long sentence is split at a comma
  dash: 220,
  clause: 300,     // ; or :
  sentence: 420,   // .
  question: 470,   // ? or !
  paragraph: 800,
  heading: 900,
};

// ---------- PDF page -> lines -> paragraphs ----------

/** Turn pdf.js textContent items into lines, keeping content-stream order
 *  (which handles multi-column layouts better than sorting by position). */
export function itemsToLines(items) {
  const lines = [];
  let cur = null;
  for (const it of items) {
    if (!("str" in it)) continue;
    const [a, b, , d, x, y] = it.transform;
    const h = Math.hypot(b, d) || Math.abs(d) || it.height || 10;
    const w = it.width || 0;
    const str = it.str;
    if (!cur) {
      cur = { text: "", x, y, h, right: x, top: y };
    } else {
      const newLine = Math.abs(y - cur.y) > Math.max(cur.h, h) * 0.5;
      if (newLine) {
        if (cur.text.trim()) lines.push(cur);
        cur = { text: "", x, y, h, right: x, top: y };
      }
    }
    if (str) {
      const gap = x - cur.right;
      if (cur.text && !/\s$/.test(cur.text) && !/^\s/.test(str) && gap > h * 0.15) cur.text += " ";
      cur.text += str;
      cur.right = Math.max(cur.right, x + w);
      cur.h = Math.max(cur.h, h);
    }
    if (it.hasEOL) {
      if (cur.text.trim()) lines.push(cur);
      cur = null;
    }
  }
  if (cur && cur.text.trim()) lines.push(cur);
  for (const l of lines) l.text = l.text.replace(/\s+/g, " ").trim();
  return lines.filter((l) => l.text);
}

const median = (arr) => {
  if (!arr.length) return 0;
  const s = [...arr].sort((p, q) => p - q);
  return s[Math.floor(s.length / 2)];
};

const normKey = (t) => t.toLowerCase().replace(/\d+/g, "#").replace(/\s+/g, " ").trim();

/** Remove running headers/footers and bare page numbers across a document.
 *  pagesLines: Array<Array<line>> */
export function stripRunningHeaders(pagesLines) {
  const n = pagesLines.length;
  const counts = new Map();
  for (const lines of pagesLines) {
    const edge = new Set([...lines.slice(0, 2), ...lines.slice(-2)].map((l) => normKey(l.text)));
    for (const k of edge) counts.set(k, (counts.get(k) || 0) + 1);
  }
  const threshold = Math.max(2, Math.ceil(n * 0.4));
  return pagesLines.map((lines) =>
    lines.filter((l, i) => {
      const t = l.text.trim();
      if (/^(page\s*)?\d{1,4}(\s*(of|\/)\s*\d{1,4})?$/i.test(t)) return false; // page numbers
      if (/^[ivxlc]{1,6}$/i.test(t) && (i < 2 || i >= lines.length - 2)) return false; // roman page nos
      const edge = i < 2 || i >= lines.length - 2;
      if (edge && n >= 2 && (counts.get(normKey(t)) || 0) >= threshold) return false;
      return true;
    })
  );
}

/** Group lines into paragraphs. Returns [{text, heading}] */
export function linesToParagraphs(lines) {
  if (!lines.length) return [];
  const hs = lines.map((l) => l.h);
  const medH = median(hs) || 10;
  const gaps = [];
  for (let i = 1; i < lines.length; i++) {
    const g = lines[i - 1].y - lines[i].y;
    if (g > 0) gaps.push(g);
  }
  const medGap = median(gaps) || medH * 1.2;
  const widths = lines.map((l) => l.right - l.x);
  const medW = median(widths) || 1;
  const medX = median(lines.map((l) => l.x));

  // OCR line heights are rough, so require a much bigger size jump for headings.
  const headingRatio = lines[0]?.ocr ? 1.45 : 1.18;
  const paras = [];
  let buf = null;
  const flush = () => {
    if (buf && buf.text.trim()) paras.push(buf);
    buf = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const prev = lines[i - 1];
    const isHeading =
      (l.h > medH * headingRatio && l.text.length < 120) ||
      (/^[A-Z0-9][A-Z0-9 ,:&'\-–—]{3,80}$/.test(l.text) && /[A-Z]{3}/.test(l.text) && l.text.split(" ").length <= 10 && !/[.]$/.test(l.text));
    let breakHere = !buf;
    if (buf && prev) {
      const gap = prev.y - l.y;
      if (gap > medGap * 1.45 || gap < -medH) breakHere = true; // big gap, or column/page jump upward
      const prevShort = prev.right - prev.x < medW * 0.75;
      if (prevShort && /[.!?:"”')\]]$/.test(prev.text)) breakHere = true;
      if (l.x > medX + medH * 0.9 && l.x - prev.x > medH * 0.9 && /[.!?:"”]$/.test(prev.text)) breakHere = true; // indent
      if (/^([•▪●◦‣∙·\-–*]|\d{1,2}[.)]|[a-z][.)])\s/.test(l.text)) breakHere = true; // list item
      if (buf.heading) breakHere = true;
    }
    if (isHeading) {
      if (buf && buf.heading && prev && prev.y - l.y < medGap * 1.6 && buf.text.length < 100) {
        buf.text += " " + l.text; // multi-line heading
        continue;
      }
      flush();
      buf = { text: l.text, heading: true };
      continue;
    }
    if (breakHere) {
      flush();
      buf = { text: l.text, heading: false };
    } else {
      buf.text = joinLine(buf.text, l.text);
    }
  }
  flush();
  return paras;
}

function joinLine(a, b) {
  // De-hyphenate words broken across lines: "infor-" + "mation"
  if (/-[A-Za-z0-9]+-$/.test(a) && /^[a-z]/.test(b)) return a + b;      // "473-year-" + "old" keeps its hyphen
  if (/[A-Za-z]-$/.test(a) && /^[a-z]/.test(b)) return a.slice(0, -1) + b;
  if (/[A-Za-z]­$/.test(a)) return a.slice(0, -1) + b;
  return a + " " + b;
}

// ---------- Photo captions and page clutter ----------
const CREDIT = /\bCredit\s*(?:\.{2,}|…|:)\s*[A-Z][\w'’.\-]*(?:\s+[A-Z][\w'’\-]*)?/;
const CLUTTER = /(Order Reprints|Today[’']s Paper|^A ?version of this article appears in print|^Advertisement$|^Skip advertisement$|^Supported by$)/i;

/** Remove photo captions ("... Credit... Jane Doe") and print/web clutter.
 *  A caption glued to the start of a paragraph is cut off; the rest is kept. */
export function stripCaptions(pages) {
  for (const pg of pages) {
    pg.paragraphs = pg.paragraphs.flatMap((p) => {
      if (CLUTTER.test(p.text)) return [];
      let t = p.text, m;
      while ((m = CREDIT.exec(t))) {
        const rest = t.slice(m.index + m[0].length).trim();
        // The caption may have spilled over from the previous page ("Credit...John" / "Riddy ...").
        t = rest.split(/\s+/).length < 3 ? "" : rest;
      }
      if (!t.trim()) return [];
      return [{ ...p, text: t.trim() }];
    });
  }
  // A caption split across pages leaves a dangling surname at the top of the next page.
  return pages;
}

/** Plain pasted text -> paragraphs */
export function plainTextToParagraphs(text) {
  return text
    .replace(/\r\n?/g, "\n")
    .split(/\n\s*\n+/)
    .map((block) => {
      const ls = block.split("\n").map((s) => s.trim()).filter(Boolean);
      if (!ls.length) return null;
      let t = ls[0];
      for (let i = 1; i < ls.length; i++) t = joinLine(t, ls[i]);
      t = t.replace(/\s+/g, " ").trim();
      const heading = ls.length === 1 && t.length < 80 && !/[.!?,;:]$/.test(t);
      return { text: t, heading };
    })
    .filter(Boolean);
}

// ---------- Cleanup for clear speech ----------

const SPOKEN = [
  [/\be\.\s?g\.,?/gi, "for example,"],
  [/\bi\.\s?e\.,?/gi, "that is,"],
  [/\bet al\./gi, "and colleagues"],
  [/\betc\.(?=\s+[A-Z]|\s*$)/g, "et cetera."],
  [/\betc\./gi, "et cetera"],
  [/\bvs?\.(?=\s)/gi, "versus"],
  [/\bapprox\./gi, "approximately"],
  [/\bcf\./gi, "compare"],
  [/\bFigs?\.\s?(?=\d)/g, "Figure "],
  [/\bEqs?\.\s?(?=\d|\()/g, "Equation "],
  [/\bNo\.\s?(?=\d)/g, "Number "],
  [/\bpp\.\s?(?=\d)/g, "pages "],
  [/\bp\.\s?(?=\d)/g, "page "],
  [/\bVol\.\s?(?=\d)/g, "Volume "],
  [/\bCh\.\s?(?=\d)/g, "Chapter "],
  [/\bSec\.\s?(?=\d)/g, "Section "],
  [/§\s?/g, "Section "],
  [/\bJan\.(?=\s)/g, "January"], [/\bFeb\.(?=\s)/g, "February"], [/\bMar\.(?=\s\d)/g, "March"],
  [/\bApr\.(?=\s)/g, "April"], [/\bAug\.(?=\s)/g, "August"], [/\bSept?\.(?=\s)/g, "September"],
  [/\bOct\.(?=\s)/g, "October"], [/\bNov\.(?=\s)/g, "November"], [/\bDec\.(?=\s)/g, "December"],
  [/\bDept\./g, "Department"],
  [/\bUniv\./g, "University"],
  [/\bJr\./g, "Junior"],
  [/\bSr\./g, "Senior"],
  [/\bSt\.(?=\s+[A-Z])/g, "Saint"],
  [/\bProf\.(?=\s+[A-Z])/g, "Professor"],
  [/\bGov\.(?=\s+[A-Z])/g, "Governor"],
  [/\bSen\.(?=\s+[A-Z])/g, "Senator"],
  [/\bRep\.(?=\s+[A-Z])/g, "Representative"],
  [/\bInc\./g, "Incorporated"],
  [/\bLtd\./g, "Limited"],
  [/\bU\.S\.A\./g, "U S A"],
  [/\bU\.S\.(?=\s+[a-z])/g, "U S"],
  [/\bU\.S\./g, "U S."],
  [/\bU\.K\./g, "U K"],
  [/\band\/or\b/gi, "and or"],
  [/\s&\s/g, " and "],
  [/\b([A-Z])&([A-Z])\b/g, "$1 and $2"],
  [/(\d)\s?%/g, "$1 percent"],
  [/(\d)\s?°\s?F\b/g, "$1 degrees Fahrenheit"],
  [/(\d)\s?°\s?C\b/g, "$1 degrees Celsius"],
  [/(\d)\s?°/g, "$1 degrees"],
  [/\s*\.{3,}|…/g, "… "],
  [/\s+[–—]\s+|—/g, " — "],
  [/(\d)\s?[–-]\s?(\d)/g, "$1 to $2"],
  [/[•▪●◦‣∙·]\s*/g, ""],
  [/[™®©]/g, ""],
];

export function cleanForSpeech(text, { skipCitations = true, skipUrls = true } = {}) {
  let t = " " + text + " ";
  t = t.replace(/[­​﻿]/g, "");
  t = t.replace(/ﬁ/g, "fi").replace(/ﬂ/g, "fl").replace(/ﬀ/g, "ff").replace(/ﬃ/g, "ffi").replace(/ﬄ/g, "ffl");
  if (skipUrls) {
    t = t.replace(/\bhttps?:\/\/\S+|\bwww\.\S+/gi, (m) => {
      const trail = m.match(/[.,;:)\]]+$/);
      return "link" + (trail ? trail[0] : "");
    });
    t = t.replace(/\bdoi:\s?\S+/gi, "");
  }
  if (skipCitations) {
    t = t.replace(/\s?\[(\d+([,–\-]\s?\d+)*)\]/g, ""); // [3], [1,2], [4–6]
    t = t.replace(/\s?\((?:[A-Z][A-Za-z'\-]+(?: (?:et al\.|and|&) [A-Z][A-Za-z'\-]+)?),? \d{4}[a-z]?(?:; [^)]+)?\)/g, ""); // (Smith, 2019)
  }
  for (const [re, rep] of SPOKEN) t = t.replace(re, rep);
  // Shouted headings like "THE ROAD AHEAD" read better in title case.
  t = t.replace(/\b([A-Z]{2,}(?:[ \-'][A-Z]{2,}){2,})\b/g, (m) => m.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase()));
  t = t.replace(/\s+([,.;:!?])/g, "$1").replace(/\s{2,}/g, " ").trim();
  return t;
}

// ---------- Sentence splitting ----------

const ABBR = new Set(
  "mr mrs ms dr prof sr jr st mt vs etc co inc ltd dept fig figs eq no vol ch sec gen col lt sgt capt cmdr adm rev hon pres gov sen rep jan feb mar apr jun jul aug sep sept oct nov dec approx al ca cf ed eds pp p op cit ibid".split(" ")
);

/** Split a paragraph into sentences. Returns [{text, end}] where end is the
 *  trailing punctuation class. */
export function splitSentences(text) {
  const out = [];
  const re = /([.!?…]+)(["'”’)\]»]*)(\s+|$)/g;
  let start = 0, m;
  while ((m = re.exec(text))) {
    const endIdx = m.index + m[1].length + m[2].length;
    const before = text.slice(start, m.index);
    const lastWord = (before.match(/([A-Za-z]+)$/) || [])[1] || "";
    const next = text.slice(re.lastIndex, re.lastIndex + 2);
    if (m[3] && m[1] === ".") {
      if (ABBR.has(lastWord.toLowerCase())) continue;
      if (/^[A-Z]$/.test(lastWord) && /^[A-Z]/.test(next)) continue; // initials: "J. Smith"
      if (/^[a-z]/.test(next)) continue; // "... the U.S. economy" etc.
      if (/\b(e\.g|i\.e|a\.m|p\.m|ca|cf|viz)$/i.test(before)) continue;
    }
    if (m[3] && /^[a-z]/.test(next) && m[1] !== ".") continue; // "?" mid-sentence quotes
    const s = text.slice(start, endIdx).trim();
    if (s) out.push({ text: s, end: endClass(s) });
    start = re.lastIndex;
  }
  const rest = text.slice(start).trim();
  if (rest) out.push({ text: rest, end: endClass(rest) });
  return out;
}

function endClass(s) {
  const c = s.replace(/["'”’)\]»]+$/, "").slice(-1);
  if (c === "?" || c === "!") return "question";
  if (c === "." || c === "…") return "sentence";
  if (c === ";" || c === ":") return "clause";
  if (c === ",") return "comma";
  if (c === "—" || c === "-") return "dash";
  return "sentence";
}

/** Break overly long sentences at natural clause boundaries so the neural
 *  model never truncates (Kokoro caps input at ~510 phoneme tokens). */
export function splitLong(sentence, maxLen = 220) {
  if (sentence.text.length <= maxLen) return [sentence];
  const t = sentence.text;
  const mid = t.length / 2;
  const tryPatterns = [/[;:](?=\s)/g, /\s—\s/g, /,(?=\s)/g, /\s(?=(?:and|but|or|which|because|while|whereas|although|so)\s)/g, /\s/g];
  for (const pat of tryPatterns) {
    let best = -1, bestDist = Infinity, m;
    while ((m = pat.exec(t))) {
      const cut = m.index + m[0].length;
      if (cut < 40 || t.length - cut < 40) continue;
      const d = Math.abs(cut - mid);
      if (d < bestDist) { bestDist = d; best = cut; }
    }
    if (best > 0) {
      const a = t.slice(0, best).trim();
      const b = t.slice(best).trim();
      return [
        ...splitLong({ text: a, end: endClass(a) === "sentence" && !/[.!?…]$/.test(a) ? "soft" : endClass(a) }, maxLen),
        ...splitLong({ text: b, end: sentence.end }, maxLen),
      ];
    }
  }
  return [sentence];
}

/** Build the playable chunk list.
 *  pages: [{num, paragraphs:[{text, heading}]}]
 *  returns { chunks:[{display, spoken, pause, para, page, heading}], paras:[{page, heading, first, last}] } */
export function buildChunks(pages, opts = {}) {
  const chunks = [];
  const paras = [];
  for (const pg of pages) {
    for (const p of pg.paragraphs) {
      const pIndex = paras.length;
      const first = chunks.length;
      const sents = p.heading ? [{ text: p.text, end: "heading" }] : splitSentences(p.text);
      const pieces = sents.flatMap((s) => splitLong(s));
      pieces.forEach((s, i) => {
        const spoken = cleanForSpeech(s.text, opts);
        if (!/[A-Za-z0-9]/.test(spoken)) return;
        let kind = s.end;
        if (p.heading) kind = "heading";
        else if (i === pieces.length - 1) kind = "paragraph";
        const pause = kind === "soft" ? 0 : PAUSES[kind] ?? PAUSES.sentence;
        // Headings without a final stop get one so the voice lands the phrase.
        const spokenFinal = p.heading && !/[.!?]$/.test(spoken) ? spoken + "." : spoken;
        chunks.push({ display: s.text, spoken: spokenFinal, pause, para: pIndex, page: pg.num, heading: !!p.heading });
      });
      if (chunks.length > first) paras.push({ page: pg.num, heading: !!p.heading, first, last: chunks.length - 1 });
    }
  }
  return { chunks, paras };
}
