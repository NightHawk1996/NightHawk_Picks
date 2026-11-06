// OddsPapi follow-up – do corners and bookings ever get settled (WIN/LOSE), or stay UNDECIDED?
// Checks the 3 most recent finished Premier League matches and 1 Championship match, and compares
// with ordinary markets (match result, goals) as a control. Uses about 7 requests. Prints no key.
// Usage: $env:ODDSPAPI_KEY = Read-Host "OddsPapi key" -MaskInput ; node scripts/oddspapi-settle-check.mjs

const KEY = process.env.ODDSPAPI_KEY?.trim();
if (!KEY) { console.error("Set ODDSPAPI_KEY first."); process.exit(1); }
const BASE = "https://api.oddspapi.io/v4";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function get(path, params = {}) {
  await sleep(2500);
  const res = await fetch(`${BASE}/${path}?${new URLSearchParams({ ...params, apiKey: KEY })}`);
  const text = await res.text();
  if (!res.ok) { console.log(`  ❌ ${path} → ${res.status}: ${text.slice(0, 200)}`); return null; }
  return JSON.parse(text);
}

const markets = (await get("markets")) ?? [];
const byId = new Map(markets.map((m) => [String(m.marketId), m]));
const groups = [
  ["Match result", (n) => /^full time result$|^1x2$/i.test(n)],
  ["Goals over/under", (n) => /^over under full time$/i.test(n)],
  ["Corners over/under", (n) => /^corners - over under full time$/i.test(n)],
  ["Corners handicap", (n) => /^corners - handicap$/i.test(n)],
  ["Bookings over/under", (n) => /^bookings - over under full time$/i.test(n)],
  ["Bookings team 1/2", (n) => /^bookings - over under team [12]$/i.test(n)],
];

const from = new Date(Date.now() - 9 * 864e5).toISOString().slice(0, 19) + "Z";
const pick = async (tid, n) => ((await get("fixtures", { tournamentId: tid, statusId: 2, from })) ?? [])
  .sort((a, b) => String(b.startTime).localeCompare(String(a.startTime))).slice(0, n);
const fixtures = [...(await pick(17, 3)), ...(await pick(18, 1))];

for (const f of fixtures) {
  console.log(`\n🏁 ${f.tournamentName}: ${f.participant1Name} v ${f.participant2Name} · ${f.startTime.slice(0, 16)}`);
  const s = await get("settlements", { fixtureId: f.fixtureId });
  const mk = s?.markets ?? {};
  for (const [label, test] of groups) {
    let win = 0, lose = 0, other = 0, und = 0; const decided = [];
    for (const [id, m] of Object.entries(mk)) {
      const meta = byId.get(id);
      if (!meta || !test(meta.marketName)) continue;
      const results = [...JSON.stringify(m).matchAll(/"result":"(\w+)"/g)].map((x) => x[1]);
      for (const r of results) r === "WIN" ? win++ : r === "LOSE" ? lose++ : r === "UNDECIDED" ? und++ : other++;
      if (results.some((r) => r === "WIN")) {
        const outs = Object.entries(m.outcomes ?? m).map(([oid, o]) => `${meta.outcomes?.find((x) => String(x.outcomeId) === oid)?.outcomeName ?? oid}=${JSON.stringify(o).match(/"result":"(\w+)"/)?.[1]}`);
        decided.push(`${meta.handicap}: ${outs.join(" ")}`);
      }
    }
    console.log(`   ${label.padEnd(20)} WIN ${win} · LOSE ${lose} · other ${other} · UNDECIDED ${und}${decided.length ? `\n      e.g. ${decided.slice(0, 4).join(" | ")}` : ""}`);
  }
}
console.log("\nDone – send me everything above.");
