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
  ["r", /^full time result$/i], ["dc", /^double chance$/i], ["btts", /^both teams to score$/i],
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
const outcome = (name) => String(name).toLowerCase();
function extract(markets) {
  const mp = {};
  for (const [mid, m] of Object.entries(markets ?? {})) {
    const meta = byId.get(mid);
    if (!meta || m.marketActive === false) continue;
    const prices = {};
    for (const [oid, o] of Object.entries(m.outcomes ?? {})) {
      const pl = Object.values(o.players ?? {})[0];
      if (pl?.active !== false && pl?.price > 1) prices[outcome(meta.o[oid] ?? oid)] = pl.price;
    }
    const k = meta.kind;
    if (k === "r" && prices["1"] && prices["x"] && prices["2"]) mp.r = [prices["1"], prices["x"], prices["2"]];
    else if (k === "dc" && (prices["1x"] || prices["x2"])) mp.dc = [prices["1x"] ?? 0, prices["12"] ?? 0, prices["x2"] ?? 0];
    else if (k === "btts" && prices["yes"] && prices["no"]) mp.btts = [prices["yes"], prices["no"]];
    else if (!["r", "dc", "btts"].includes(k) && prices["over"] && prices["under"]) (mp[k] ??= {})[meta.line] = [prices["over"], prices["under"]];
  }
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
    let n = 0;
    for (const f of Array.isArray(data) ? data : Object.values(data)) {
      const fx = names.get(f.fixtureId);
      if (!fx) continue; // outside the window
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
