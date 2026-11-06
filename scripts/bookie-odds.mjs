// Runs in GitHub Actions each morning (.github/workflows/bookie-odds.yml): downloads bet365 and
// Paddy Power prices from OddsPapi, keeps only the markets Hawk uses for the next 3 days, and
// saves a small file per league into Hawk's Cloudflare storage (bookies:PL, bookies:ELC, …).
// The raw files are 8–14 MB each – far too big for Hawk's 10ms Cloudflare budget, fine here.
//
// Requests: 1 fixtures call + up to 3 per bookie, only for leagues with games in the window
// (~150–210 of the 250 a month). The market list is cached by GitHub for a week.
//
// Needs (GitHub secrets): ODDSPAPI_KEY, CF_API_TOKEN, CF_ACCOUNT_ID, CF_KV_NAMESPACE_ID
// Test on your PC without saving: node scripts/bookie-odds.mjs --dry-run   (needs ODDSPAPI_KEY)

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";

const env = process.env;
const DRY = process.argv.includes("--dry-run");
const DEBUG = process.argv.includes("--debug");
const KEY = env.ODDSPAPI_KEY?.trim();
if (!KEY) throw new Error("ODDSPAPI_KEY is missing");
if (!DRY && !(env.CF_API_TOKEN && env.CF_ACCOUNT_ID && env.CF_KV_NAMESPACE_ID)) throw new Error("Cloudflare secrets missing (CF_API_TOKEN, CF_ACCOUNT_ID, CF_KV_NAMESPACE_ID)");

const BOOKS = { bet365: "bet365", paddypower: "Paddy Power" };
const TOURNAMENTS = { 17: "PL", 18: "ELC", 8: "PD", 23: "SA", 35: "BL1", 34: "FL1", 7: "CL" };
const WINDOW_HOURS = 72; // covers Friday's weekend accas through to Sunday night
const BASE = "https://api.oddspapi.io/v4";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let used = 0;

async function get(path, params = {}) {
  await sleep(2200); // OddsPapi asks for 1–2 seconds between calls
  used++;
  const res = await fetch(`${BASE}/${path}?${new URLSearchParams({ ...params, apiKey: KEY })}`);
  const text = await res.text();
  if (!res.ok) throw new Error(`${path} → ${res.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

// 1. Market list (which ID is "Corners - Over Under Full Time 9.5"…) – cached for a week
const CACHE = ".cache/oddspapi-markets.json";
let markets;
if (existsSync(CACHE)) markets = JSON.parse(readFileSync(CACHE, "utf8"));
else {
  markets = (await get("markets")).filter((m) => m.sportId === 10 && !m.playerProp && m.period === "fulltime")
    .map((m) => ({ id: m.marketId, name: m.marketName, h: m.handicap, o: Object.fromEntries(m.outcomes.map((x) => [x.outcomeId, x.outcomeName])) }));
  mkdirSync(".cache", { recursive: true });
  writeFileSync(CACHE, JSON.stringify(markets));
}
const KINDS = [
  ["r", /^full time result$/i], ["dc", /^double chance( full time)?$/i], ["btts", /^both teams to score$/i],
  ["g", /^over under full time$/i], ["t1", /^over under team 1$/i], ["t2", /^over under team 2$/i],
  ["c", /^corners - over under full time$/i], ["c1", /^corners - over under team 1$/i], ["c2", /^corners - over under team 2$/i],
  ["k", /^bookings - over under full time$/i], ["k1", /^bookings - over under team 1$/i], ["k2", /^bookings - over under team 2$/i],
];
const byId = new Map();
for (const m of markets) {
  const kind = KINDS.find(([, re]) => re.test(m.name))?.[0];
  if (kind) byId.set(String(m.id), { kind, line: String(m.h), o: m.o });
}
const found = new Set([...byId.values()].map((x) => x.kind));
console.log(`Markets: ${byId.size} usable · kinds found: ${[...found].join(", ")}`);
const missing = KINDS.map(([k]) => k).filter((k) => !found.has(k));
if (missing.length) console.log(`⚠️ Not found: ${missing.join(", ")} · names with "double": ${markets.filter((m) => /double/i.test(m.name)).map((m) => m.name).slice(0, 8).join(" | ") || "none"}`);

// 2. Fixtures in the window, with team names
const now = new Date(), until = new Date(now.getTime() + WINDOW_HOURS * 3600e3);
const iso = (d) => d.toISOString().slice(0, 19) + "Z";
const fixtures = (await get("fixtures", { sportId: 10, from: iso(now), to: iso(until) }))
  .filter((f) => TOURNAMENTS[f.tournamentId] && f.statusId === 0);
const names = new Map(fixtures.map((f) => [f.fixtureId, f]));
const withGames = [...new Set(fixtures.map((f) => f.tournamentId))];
console.log(`Fixtures in the next ${WINDOW_HOURS}h: ${fixtures.length} · leagues: ${withGames.map((t) => TOURNAMENTS[t]).join(", ") || "none"}`);

// 3. Prices – up to 3 leagues per call, one bookie per call
// Outcome names vary by market: "1"/"X"/"2", "Over"/"Under", "Yes"/"No", and double chance as
// "1X", "Home or Draw", "1/X", "X1"… – all brought to one spelling.
function outcome(name) {
  let t = String(name).toLowerCase().replace(/home/g, "1").replace(/away/g, "2").replace(/draw/g, "x").replace(/\s|\/|or|-/g, "");
  if (t === "x1") t = "1x";
  if (t === "2x") t = "x2";
  if (t === "21") t = "12";
  return t;
}
let shownDc = false;
function extract(markets) {
  const mp = {};
  for (const [mid, m] of Object.entries(markets ?? {})) {
    const meta = byId.get(mid);
    // bet365's feed marks whole markets inactive even when every price in them is live, so
    // judge each price on its own: active, and updated in the last 36 hours.
    if (!meta) continue;
    const prices = {};
    for (const [oid, o] of Object.entries(m.outcomes ?? {})) {
      const pl = Object.values(o.players ?? {})[0];
      const fresh = !pl?.changedAt || Date.now() - Date.parse(pl.changedAt) < 36 * 3600e3;
      if (pl?.active !== false && pl?.price > 1 && fresh) prices[outcome(meta.o[oid] ?? oid)] = pl.price;
    }
    const k = meta.kind;
    if (DEBUG && k === "dc" && !shownDc) { shownDc = true; console.log(`   [debug] double chance outcome names: ${Object.values(meta.o).join(", ")} → read as ${JSON.stringify(prices)}`); }
    if (k === "r") mp.r = [prices["1"] ?? mp.r?.[0] ?? 0, prices["x"] ?? mp.r?.[1] ?? 0, prices["2"] ?? mp.r?.[2] ?? 0];
    // Double chance can arrive split across several market entries (one with 1X, another with
    // X2…), so fill in the three prices from whichever entries have them.
    if (k === "dc") mp.dc = [prices["1x"] ?? mp.dc?.[0] ?? 0, prices["12"] ?? mp.dc?.[1] ?? 0, prices["x2"] ?? mp.dc?.[2] ?? 0];
    else if (k === "btts" && prices["yes"] && prices["no"]) mp.btts = [prices["yes"], prices["no"]];
    else if (!["r", "dc", "btts"].includes(k) && prices["over"] && prices["under"]) (mp[k] ??= {})[meta.line] = [prices["over"], prices["under"]];
  }
  if (mp.dc && !mp.dc[0] && !mp.dc[2]) delete mp.dc;
  if (mp.r && !(mp.r[0] && mp.r[1] && mp.r[2])) delete mp.r; // a match result needs all three prices
  return mp;
}

const games = new Map(); // fixtureId → { home, away, kickOff, code, books }
const groups = [];
for (let i = 0; i < withGames.length; i += 3) groups.push(withGames.slice(i, i + 3));
for (const [slug, label] of Object.entries(BOOKS)) {
  for (const group of groups) {
    let data;
    try { data = await get("odds-by-tournaments", { tournamentIds: group.join(","), bookmaker: slug }); }
    catch (e) { console.log(`⚠️ ${label} ${group.map((t) => TOURNAMENTS[t]).join("/")}: ${e.message}`); continue; }
    let n = 0, debugged = false;
    const list = Array.isArray(data) ? data : Object.values(data);
    if (DEBUG) console.log(`   [debug] ${label}: ${list.length} fixtures returned, ${list.filter((f) => names.has(f.fixtureId)).length} in the window`);
    for (const f of list) {
      const fx = names.get(f.fixtureId);
      if (!fx) continue; // outside the window
      if (DEBUG && !debugged) {
        debugged = true;
        const raw = f.bookmakerOdds?.[slug];
        const mks = Object.entries(raw?.markets ?? {});
        const ours = mks.filter(([id]) => byId.has(id));
        const inactive = ours.filter(([, m]) => m.marketActive === false).length;
        const r = ours.find(([id]) => byId.get(id).kind === "r") ?? ours[0];
        console.log(`   [debug] ${label} ${fx.participant1Name} v ${fx.participant2Name}: bookie keys ${Object.keys(f.bookmakerOdds ?? {}).join(",")} · active ${raw?.bookmakerIsActive} · suspended ${raw?.suspended} · ${mks.length} markets, ${ours.length} Hawk uses, ${inactive} marked inactive`);
        if (r) console.log(`   [debug] market ${r[0]} (${byId.get(r[0]).kind} ${byId.get(r[0]).line}): ${JSON.stringify(r[1]).slice(0, 700)}`);
        const unknown = mks.filter(([id]) => !byId.has(id)).slice(0, 8).map(([id]) => id);
        console.log(`   [debug] sample of market IDs not used: ${unknown.join(", ")}`);
      }
      const mp = extract(f.bookmakerOdds?.[slug]?.markets);
      if (!Object.keys(mp).length) continue;
      const g = games.get(f.fixtureId) ?? { home: fx.participant1Name, away: fx.participant2Name, kickOff: fx.startTime, code: TOURNAMENTS[fx.tournamentId], books: {} };
      g.books[label] = mp;
      games.set(f.fixtureId, g);
      n++;
    }
    console.log(`${label} · ${group.map((t) => TOURNAMENTS[t]).join("/")}: ${n} games priced`);
  }
}

// 4. Save one small file per league
const byCode = {};
for (const { code, ...g } of games.values()) (byCode[code] ??= []).push(g);
for (const [code, list] of Object.entries(byCode)) {
  const body = JSON.stringify({ generated: now.toISOString(), games: list });
  const sample = list[0];
  console.log(`${code}: ${list.length} games · ${Math.round(body.length / 1024)} KB · e.g. ${sample.home} v ${sample.away}: ${Object.entries(sample.books).map(([b, m]) => `${b} [${Object.keys(m).join(" ")}]`).join(" · ")}`);
  if (DRY) continue;
  const url = `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/storage/kv/namespaces/${env.CF_KV_NAMESPACE_ID}/values/${encodeURIComponent(`bookies:${code}`)}?expiration_ttl=${4 * 86400}`;
  const res = await fetch(url, { method: "PUT", headers: { Authorization: `Bearer ${env.CF_API_TOKEN}`, "Content-Type": "application/json" }, body });
  if (!res.ok) throw new Error(`Saving bookies:${code} failed – ${res.status}: ${(await res.text()).slice(0, 200)}`);
}
console.log(`✅ Done – ${games.size} games, ${used} OddsPapi requests used${DRY ? " (dry run – nothing saved)" : ""}`);
