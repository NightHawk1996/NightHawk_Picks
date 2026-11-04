// Festival trends – downloads the winners of every Cheltenham Festival race and the Grand
// National from Wikipedia (free to reuse, CC BY-SA), and saves them for Hawk's /trends command.
// Runs on your PC. Usage, from the project folder:
//   node scripts/festival-trends.mjs
//   npx wrangler kv key put trends:festival --path festival-trends.json --binding HAWK --remote
//
// It reads each page's winners table by its column names, prints every winner so you can
// check them, and lists any race it couldn't find.

import { writeFileSync, mkdirSync } from "node:fs";

const YEARS = 15; // most recent runnings to keep

// [Hawk's name, meeting, day, Wikipedia page]
const RACES = [
  ["Supreme Novices' Hurdle", "Cheltenham", 1, "Supreme Novices' Hurdle"],
  ["Arkle Challenge Trophy", "Cheltenham", 1, "Arkle Challenge Trophy"],
  ["Ultima Handicap Chase", "Cheltenham", 1, "Ultima Handicap Chase"],
  ["Champion Hurdle", "Cheltenham", 1, "Champion Hurdle"],
  ["Mares' Hurdle", "Cheltenham", 1, "Mares' Hurdle"],
  ["Fred Winter Juvenile Handicap Hurdle", "Cheltenham", 1, "Fred Winter Juvenile Novices' Handicap Hurdle"],
  ["National Hunt Chase", "Cheltenham", 1, "National Hunt Chase Challenge Cup"],
  ["Baring Bingham Novices' Hurdle", "Cheltenham", 2, "Baring Bingham Novices' Hurdle"],
  ["Brown Advisory Novices' Chase", "Cheltenham", 2, "Brown Advisory Novices' Chase"],
  ["Coral Cup", "Cheltenham", 2, "Coral Cup"],
  ["Queen Mother Champion Chase", "Cheltenham", 2, "Queen Mother Champion Chase"],
  ["Cross Country Chase", "Cheltenham", 2, "Glenfarclas Cross Country Chase"],
  ["Champion Bumper", "Cheltenham", 2, "Champion Bumper"],
  ["Golden Miller Novices' Chase", "Cheltenham", 3, "Golden Miller Novices' Chase"],
  ["Pertemps Final", "Cheltenham", 3, "Pertemps Final"],
  ["Ryanair Chase", "Cheltenham", 3, "Ryanair Chase"],
  ["Stayers' Hurdle", "Cheltenham", 3, "Stayers' Hurdle"],
  ["Festival Plate", "Cheltenham", 3, "Festival Plate"],
  ["Mares' Novices' Hurdle", "Cheltenham", 3, "Mares' Novices' Hurdle"],
  ["Kim Muir Challenge Cup", "Cheltenham", 3, "Kim Muir Challenge Cup"],
  ["Triumph Hurdle", "Cheltenham", 4, "Triumph Hurdle"],
  ["County Handicap Hurdle", "Cheltenham", 4, "County Handicap Hurdle"],
  ["Albert Bartlett Novices' Hurdle", "Cheltenham", 4, "Spa Novices' Hurdle"],
  ["Cheltenham Gold Cup", "Cheltenham", 4, "Cheltenham Gold Cup"],
  ["Foxhunter Chase", "Cheltenham", 4, "Foxhunter Chase"],
  ["Martin Pipe Handicap Hurdle", "Cheltenham", 4, "Martin Pipe Conditional Jockeys' Handicap Hurdle"],
  ["Grand Annual Chase", "Cheltenham", 4, "Grand Annual Chase"],
  ["Grand National", "Aintree", 3, "List of Grand National winners"],
];

const API = "https://en.wikipedia.org/w/api.php";
const HEADERS = { "User-Agent": "NightHawkPicks/1.0 (personal project; festival trends)" };

// Wikipedia asks automated tools to go slowly and back off when told to – so this waits
// between requests, and if Wikipedia says "too many", waits longer and tries again.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function wiki(params) {
  for (let attempt = 1; attempt <= 6; attempt++) {
    const res = await fetch(`${API}?${params}&format=json&formatversion=2&maxlag=5`, { headers: HEADERS });
    const text = await res.text();
    if (res.ok && text.startsWith("{")) {
      const data = JSON.parse(text);
      if (data.error?.code !== "maxlag") return data;
    }
    const wait = Number(res.headers.get("retry-after")) * 1000 || attempt * 5000;
    console.log(`  (Wikipedia asked us to slow down – waiting ${Math.round(wait / 1000)}s)`);
    await sleep(wait);
  }
  throw new Error("Wikipedia kept refusing – try again in a few minutes");
}
async function pageHtml(title) {
  const data = await wiki(`action=parse&page=${encodeURIComponent(title)}&redirects=1&prop=text`);
  return data.error ? null : data.parse.text;
}
// If the exact page name has moved, ask Wikipedia's search for the closest race page.
// Only accept a page that's about the right meeting and shares a word with the race name.
async function findPage(name, meeting) {
  const data = await wiki(`action=query&list=search&srsearch=${encodeURIComponent(`${name} ${meeting}`)}&srlimit=5`);
  const words = name.toLowerCase().replace(/[^a-z ]/g, "").split(" ").filter((w) => w.length > 3 && !/hurdle|chase|novices|handicap|challenge|trophy|festival|cheltenham|aintree/.test(w));
  for (const r of data.query?.search ?? []) {
    const title = r.title.toLowerCase();
    if (/festival$|racecourse|^list of/.test(title) && !/national/.test(name.toLowerCase())) continue; // the meeting's own page, not the race
    if (!words.some((w) => title.includes(w))) continue;
    const html = await pageHtml(r.title);
    if (html && new RegExp(meeting, "i").test(html)) return r.title;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Reading Wikipedia tables
// ---------------------------------------------------------------------------
const decode = (s) => s
  // Hidden sorting codes (e.g. "13-03-2018" before "2020, 10 March") – invisible on the page
  .replace(/<span[^>]*(display:\s*none|class="[^"]*sortkey)[^>]*>[\s\S]*?<\/span>/gi, "")
  .replace(/<sup[\s\S]*?<\/sup>/g, "")          // reference markers [1]
  .replace(/<style[\s\S]*?<\/style>/g, "")
  .replace(/<br\s*\/?>/g, " ")
  .replace(/<[^>]+>/g, "")
  .replace(/&nbsp;|&#160;/g, " ").replace(/&amp;/g, "&").replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&ndash;|&#8211;/g, "–").replace(/&frasl;|⁄/g, "/")
  .replace(/\[\d+\]/g, "").replace(/\s+/g, " ").trim();

export function readTables(html) {
  const tables = [];
  // Every table on the page – many race pages use plain tables rather than "wikitable" ones.
  // Info boxes and navigation boxes are skipped; they never have Year and Winner columns anyway.
  for (const t of html.match(/<table[\s>][\s\S]*?<\/table>/g) ?? []) {
    if (/^<table[^>]*class="[^"]*(infobox|navbox|metadata|ambox)/.test(t)) continue;
    const rows = [];
    const carry = []; // rowspan cells still to fill: { col, text, left }
    for (const tr of t.split(/<tr[\s>]/).slice(1)) {
      const cells = [];
      for (const m of tr.matchAll(/<(t[hd])([^>]*)>([\s\S]*?)(?=<t[hd][\s>]|<\/tr>|$)/g)) {
        const attrs = m[2];
        const text = decode(m[3]);
        const span = Number(attrs.match(/rowspan="?(\d+)/)?.[1] ?? 1);
        const cols = Number(attrs.match(/colspan="?(\d+)/)?.[1] ?? 1);
        cells.push({ text, span, cols, head: m[1] === "th" });
      }
      // Lay the cells out, filling in any cells carried down from rows above (rowspan)
      const row = [];
      let i = 0;
      const pending = carry.filter((c) => c.left > 0);
      for (let col = 0; i < cells.length || pending.some((c) => c.col >= col); col++) {
        const carried = pending.find((c) => c.col === col);
        if (carried) { row.push(carried.text); carried.left--; continue; }
        const c = cells[i++];
        if (!c) break;
        for (let k = 0; k < c.cols; k++) row.push(c.text);
        if (c.span > 1) carry.push({ col, text: c.text, left: c.span - 1 });
        col += c.cols - 1;
      }
      for (let k = carry.length - 1; k >= 0; k--) if (carry[k].left <= 0) carry.splice(k, 1);
      rows.push({ cells: row, head: cells.length > 0 && cells.every((c) => c.head) });
    }
    tables.push(rows);
  }
  return tables;
}

// Find the winners table and read it by its column names
export function winnersFrom(html) {
  let best = null;
  for (const rows of readTables(html)) {
    const headIdx = rows.findIndex((r) => r.head || r.cells.some((c) => /^winner$|^horse$/i.test(c)));
    if (headIdx < 0) continue;
    const head = rows[headIdx].cells.map((c) => c.toLowerCase());
    const col = (re) => head.findIndex((h) => re.test(h));
    const c = { year: col(/^(year|date|season)/), winner: col(/^(winner|horse)/), age: col(/^age/), weight: col(/handicap|weight|^wt/), jockey: col(/^jockey/), trainer: col(/^trainer/), sp: col(/^sp$|starting price|^odds|^sp\b/), field: col(/^field|runners|^ran/) };
    if (c.year < 0 || c.winner < 0) continue;
    const out = [];
    for (const r of rows.slice(headIdx + 1)) {
      const cell = (k) => (c[k] >= 0 ? r.cells[c[k]] ?? "" : "");
      const year = Number(cell("year").match(/(18|19|20)\d\d/)?.[0]);
      const winner = cell("winner").replace(/\(.*?\)/g, "").replace(/[†‡*§¶#]/g, "").trim();
      if (!year || !winner) continue;
      if (/cancel|abandon|void|no race|not run/i.test(cell("winner"))) { out.push({ year, cancelled: true }); continue; }
      const trainerRaw = cell("trainer");
      const sp = cell("sp");
      out.push({
        year, winner,
        age: Number(cell("age").match(/\d+/)?.[0]) || null,
        weight: cell("weight").match(/(\d+)\s*[-–]\s*(\d+)/)?.slice(1, 3).join("-") ?? null,
        jockey: cell("jockey").replace(/\(.*?\)/g, "").trim() || null,
        trainer: trainerRaw.replace(/\(.*?\)/g, "").trim() || null,
        country: trainerRaw.match(/\((IRE|GB|FR|USA)\)/)?.[1] ?? null,
        sp: sp.match(/(\d+\s*\/\s*\d+|evens|evs)/i)?.[0].replace(/\s/g, "").replace(/^ev(en)?s$/i, "Evens") ?? null,
        fav: /\bJ?F\b|fav/i.test(sp.replace(/\d+\/\d+|evens|evs/i, " ")) ? (/JF|jt/i.test(sp) ? "joint" : "yes") : null,
        field: Number(cell("field").match(/\d+/)?.[0]) || null,
      });
    }
    out.raw = rows.slice(headIdx + 1).map((r) => r.cells.join(" | "));
    if (!best || out.length > best.length) best = out;
  }
  if (best?.length) return best;
  return winnersFromList(html);
}

// Smaller races list winners as bullets – "2019 – Klassical Dream". Names only.
function winnersFromList(html) {
  // Only look in the "Winners" section, so other lists on the page are ignored
  // Look at each heading on its own (never running into the next one) for "Winners"
  let start = -1;
  for (const h of html.matchAll(/<h[23][^>]*>([\s\S]*?)<\/h[23]>/gi)) {
    if (/winner/i.test(decode(h[1]))) { start = h.index + h[0].length; break; }
  }
  if (start < 0) return [];
  const rest = html.slice(start);
  const end = rest.search(/<h2[\s>]/i);
  const section = end > 0 ? rest.slice(0, end) : rest;
  const out = [];
  for (const m of section.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/g)) {
    const text = decode(m[1]);
    const hit = text.match(/^((?:19|20)\d\d)\s*[–—:-]\s*(.+)$/);
    if (!hit) continue;
    const year = Number(hit[1]), rest2 = hit[2];
    if (/cancel|abandon|no race|not run|void/i.test(rest2)) { out.push({ year, cancelled: true }); continue; }
    const winner = rest2.replace(/\(.*?\)/g, "").replace(/[†‡*§¶#]/g, "").split(/\s[–—-]\s/)[0].trim();
    if (winner && winner.length < 40) out.push({ year, winner, age: null, weight: null, jockey: null, trainer: null, country: null, sp: null, fav: null, field: null, namesOnly: true });
  }
  out.raw = [];
  return out;
}

// Years missing between the oldest and newest kept – shown with the raw row text so a
// reader problem can be spotted, rather than silently leaving gaps.
function gaps(winners, raw) {
  const years = new Set(winners.map((w) => w.year));
  const lo = Math.min(...years), hi = Math.max(...years);
  const missing = [];
  const problems = [];
  for (let y = lo; y <= hi; y++) if (!years.has(y)) missing.push(y);
  return missing.map((y) => ({ year: y, rows: (raw ?? []).filter((r) => r.includes(String(y))).slice(0, 2) }));
}

// ---------------------------------------------------------------------------
if (process.argv[1]?.endsWith("festival-trends.mjs")) {
  const result = { generated: new Date().toISOString(), source: "Wikipedia (CC BY-SA)", races: [] };
  const missing = [];
  const problems = [];
  for (const [name, meeting, day, page] of RACES) {
    let title = page, html = await pageHtml(page);
    if (!html || !winnersFrom(html).length) {
      const alt = await findPage(name, meeting);
      if (alt && alt !== page) { title = alt; html = await pageHtml(alt); }
    }
    const all = html ? winnersFrom(html) : [];
    const winners = [...all].sort((a, b) => b.year - a.year).slice(0, YEARS);
    if (!winners.length) {
      // Save the page so the reader can be fixed for it – send one of these files if asked
      if (html) { mkdirSync("trends-pages", { recursive: true }); writeFileSync(`trends-pages/${name.replace(/[^a-z0-9]+/gi, "-")}.html`, html); }
      missing.push(`${name} (tried "${page}"${title && title !== page ? ` and "${title}"` : ""}${html ? "" : " – page not found"})`);
      continue;
    }
    result.races.push({ name, meeting, day, page: title, winners });
    console.log(`\n${meeting === "Aintree" ? "🏇" : "🏆"} ${name}  – from "${title}"${winners[0]?.namesOnly ? "  (winners' names only on Wikipedia)" : ""}`);
    for (const w of winners.slice(0, 5)) {
      console.log(w.cancelled ? `  ${w.year}  (not run)` : `  ${w.year}  ${w.winner.padEnd(24)} ${String(w.sp ?? "?").padEnd(6)}${w.fav ? (w.fav === "joint" ? "JF" : "F ") : "  "} age ${w.age ?? "?"}${w.weight ? `  ${w.weight}` : ""}  ${w.trainer ?? "?"}${w.country ? ` (${w.country})` : ""}`);
    }
    if (winners.length > 5) console.log(`  … and ${winners.length - 5} more`);
    for (const g of gaps(winners, all.raw)) {
      console.log(`  ⚠️ ${g.year} missing${g.rows.length ? ` – the page row reads: ${g.rows.map((r) => `"${r.slice(0, 120)}"`).join(" / ")}` : " – no row found for that year"}`);
      problems.push(`${name} ${g.year}`);
    }
    await sleep(1500); // be polite to Wikipedia
  }
  writeFileSync("festival-trends.json", JSON.stringify(result));
  console.log(`\n✅ ${result.races.length} races saved to festival-trends.json`);
  if (missing.length) console.log(`⚠️ Couldn't find a winners table for:\n  ${missing.join("\n  ")}\n  (Those pages are saved in the trends-pages folder – send me one if I ask)`);
  if (problems.length) console.log(`⚠️ Years with gaps (send me these lines): ${problems.join(", ")}`);
  console.log("\nUpload it for Hawk with:\n  npx wrangler kv key put trends:festival --path festival-trends.json --binding HAWK --remote");
}
