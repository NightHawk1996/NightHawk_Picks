// OddsPapi bookies probe – which UK/Irish bookies are available, and how big a day's prices are
// (Hawk runs on a 10ms CPU budget, so size matters). Uses about 4 requests. Prints no key.
// Usage: $env:ODDSPAPI_KEY = Read-Host "OddsPapi key" -MaskInput ; node scripts/oddspapi-bookies-probe.mjs

const KEY = process.env.ODDSPAPI_KEY?.trim();
if (!KEY) { console.error("Set ODDSPAPI_KEY first."); process.exit(1); }
const BASE = "https://api.oddspapi.io/v4";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function get(path, params = {}) {
  await sleep(2500);
  const t0 = Date.now();
  const res = await fetch(`${BASE}/${path}?${new URLSearchParams({ ...params, apiKey: KEY })}`);
  const text = await res.text();
  if (!res.ok) { console.log(`  ❌ ${path} → ${res.status}: ${text.slice(0, 200)}`); return null; }
  const p0 = performance.now(); const json = JSON.parse(text); const parseMs = performance.now() - p0;
  return { json, kb: Math.round(text.length / 1024), parseMs, ms: Date.now() - t0 };
}

const UKIE = /bet365|paddy|boyle|betfair|sky ?bet|william|ladbrokes|coral|betvictor|unibet|betway|888|bwin|pinnacle|betfred|livescore|kwiff/i;
const books = (await get("bookmakers"))?.json ?? [];
const list = (Array.isArray(books) ? books : Object.values(books)).map((b) => ({ slug: b.slug ?? b.bookmaker ?? b.id, name: b.bookmakerName ?? b.name ?? b.slug }));
console.log(`📚 ${list.length} bookmakers · UK/Irish ones:\n   ${list.filter((b) => UKIE.test(`${b.slug} ${b.name}`)).map((b) => `${b.name} (${b.slug})`).join(" · ") || "none matched"}`);

const markets = (await get("markets"))?.json ?? [];
const byId = new Map(markets.map((m) => [String(m.marketId), m]));

for (const slug of ["bet365", "paddypower"]) {
  if (list.length && !list.some((b) => b.slug === slug)) { console.log(`\n⚠️ ${slug} isn't on the list – skipped`); continue; }
  const r = await get("odds-by-tournaments", { tournamentIds: "17,18,8", bookmaker: slug });
  if (!r) continue;
  const fx = Array.isArray(r.json) ? r.json : Object.values(r.json);
  const mk = fx.map((f) => Object.keys(f.bookmakerOdds?.[slug]?.markets ?? {}));
  const names = new Set(mk.flat().map((id) => byId.get(id)?.marketName).filter(Boolean));
  const want = ["Full Time Result", "1X2", "Double Chance", "Both Teams To Score", "Over Under Full Time", "Corners - Over Under Full Time", "Bookings - Over Under Full Time", "Over Under Team 1", "Over Under Team 2"];
  console.log(`\n💷 ${slug} – Premier League, Championship, LaLiga in one call:`);
  console.log(`   ${fx.length} fixtures · ${Math.round(mk.flat().length / Math.max(fx.length, 1))} markets per fixture · ${r.kb} KB · JSON parse ${r.parseMs.toFixed(0)} ms on your PC`);
  console.log(`   first kick-off ${fx.map((f) => f.startTime).sort()[0]?.slice(0, 16)} · last ${fx.map((f) => f.startTime).sort().at(-1)?.slice(0, 16)}`);
  console.log(`   markets Hawk needs: ${want.map((w) => `${w} ${[...names].some((n) => n.toLowerCase() === w.toLowerCase()) ? "✅" : "❌"}`).join(" · ")}`);
}
console.log("\nDone – send me everything above.");
