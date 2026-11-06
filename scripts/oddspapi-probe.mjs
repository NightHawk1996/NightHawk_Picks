// OddsPapi probe – checks what the free plan gives for corners and cards, before Hawk relies on it:
//   1. your quota   2. the league IDs Hawk needs   3. which corners/bookings markets exist
//   4. a finished Premier League match's settlements (do corners & cards come back WIN/LOSE?)
//   5. an upcoming match's corners/bookings prices from Pinnacle
// Uses about 6 of your 250 monthly requests. Prints no key.
// Usage (PowerShell), from the project folder:
//   $env:ODDSPAPI_KEY = Read-Host "OddsPapi key" -MaskInput
//   node scripts/oddspapi-probe.mjs

const KEY = process.env.ODDSPAPI_KEY?.trim();
if (!KEY) { console.error("Set ODDSPAPI_KEY first (see the top of this file)."); process.exit(1); }
const BASE = "https://api.oddspapi.io/v4";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(path, params = {}) {
  await sleep(2500); // the slowest endpoint asks for 2 seconds between calls
  const qs = new URLSearchParams({ ...params, apiKey: KEY });
  const res = await fetch(`${BASE}/${path}?${qs}`);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  if (!res.ok) console.log(`  ❌ ${path} → ${res.status}: ${text.slice(0, 200).replace(/\s+/g, " ")}`);
  return res.ok ? json : null;
}
const SP = /corner|card|booking/i;

console.log("Probing OddsPapi…\n");

// 1. Quota
const acct = await get("account");
if (acct) console.log(`📊 Account fields: ${Object.keys(acct).join(", ")}\n   ${JSON.stringify(acct).replace(new RegExp(KEY, "g"), "***").slice(0, 300)}`);

// 2. League IDs
const tours = (await get("tournaments", { sportId: 10 })) ?? [];
const want = [["england", /^premier league$/i], ["england", /^championship$/i], ["spain", /^laliga$|^la liga$/i], ["italy", /^serie a$/i], ["germany", /^bundesliga$/i], ["france", /^ligue 1$/i], ["", /^uefa champions league$/i], ["", /^uefa europa league$/i], ["", /conference league/i]];
console.log("\n🏟️ League IDs:");
for (const [cat, re] of want) {
  const t = tours.find((t) => re.test(t.tournamentName) && (!cat || t.categorySlug === cat));
  console.log(`   ${String(re).slice(1, 30).padEnd(30)} → ${t ? `${t.tournamentId}  (${t.categoryName} – ${t.tournamentName})` : "not found"}`);
}

// 3. Corners & bookings markets
const markets = (await get("markets")) ?? [];
const byId = new Map(markets.map((m) => [m.marketId, m]));
const spm = markets.filter((m) => m.sportId === 10 && SP.test(m.marketName) && !m.playerProp);
console.log(`\n🚩🟨 Soccer corners/cards markets: ${spm.length}`);
const names = [...new Set(spm.map((m) => `${m.marketName}${m.period ? ` [${m.period}]` : ""}`))];
console.log("   " + names.slice(0, 30).join("\n   "));
console.log(`   example: ${JSON.stringify(spm[0] ?? {}).slice(0, 300)}`);

// 4. A finished Premier League match and its settlements
const from = new Date(Date.now() - 8 * 864e5).toISOString().slice(0, 19) + "Z";
const fixtures = (await get("fixtures", { tournamentId: 17, statusId: 2, from })) ?? [];
const done = fixtures.sort((a, b) => String(b.startTime).localeCompare(String(a.startTime)))[0];
if (!done) console.log("\n⚠️ No finished Premier League match found in the last 8 days");
else {
  console.log(`\n🏁 Settlements for ${done.participant1Name} v ${done.participant2Name} (${done.startTime}, ended ${done.trueEndTime ?? "?"})`);
  const s = await get("settlements", { fixtureId: done.fixtureId });
  if (s) {
    const mk = s.markets ?? s[done.fixtureId]?.markets ?? s[done.fixtureId] ?? s;
    const ids = Object.keys(mk ?? {}).map(Number).filter(Boolean);
    console.log(`   ${ids.length} markets settled · top-level fields: ${Object.keys(s).join(", ")}`);
    const sp = ids.filter((id) => SP.test(byId.get(id)?.marketName ?? ""));
    console.log(`   corners/cards markets settled: ${sp.length}`);
    for (const id of sp.slice(0, 12)) {
      const m = byId.get(id);
      const outs = Object.entries(mk[id]?.outcomes ?? mk[id] ?? {}).map(([oid, o]) => {
        const name = m.outcomes?.find((x) => String(x.outcomeId) === oid)?.outcomeName ?? oid;
        const res = JSON.stringify(o).match(/"result":"(\w+)"/)?.[1] ?? "?";
        return `${name} ${res}`;
      });
      console.log(`   • ${m.marketName}${m.handicap ? ` ${m.handicap}` : ""}: ${outs.join(" · ")}`);
    }
    if (!sp.length) console.log(`   raw sample: ${JSON.stringify(s).slice(0, 400)}`);
  }
}

// 5. Upcoming prices from Pinnacle – are corners/bookings priced?
const odds = await get("odds-by-tournaments", { tournamentIds: 17, bookmakers: "pinnacle" });
if (odds) {
  const list = Array.isArray(odds) ? odds : Object.values(odds);
  const f = list[0];
  const mks = f?.bookmakerOdds?.pinnacle?.markets ?? f?.markets ?? {};
  const ids = Object.keys(mks).map(Number);
  const sp = ids.filter((id) => SP.test(byId.get(id)?.marketName ?? ""));
  console.log(`\n💷 Pinnacle prices for ${f?.participant1Name ?? f?.fixtureId ?? "next match"}: ${ids.length} markets, ${sp.length} corners/cards`);
  console.log("   " + sp.slice(0, 12).map((id) => `${byId.get(id).marketName}${byId.get(id).handicap ? ` ${byId.get(id).handicap}` : ""}`).join("\n   "));
  if (!ids.length) console.log(`   raw sample: ${JSON.stringify(f ?? odds).slice(0, 400)}`);
}

const after = await get("account");
if (after) console.log(`\n📊 Account after: ${JSON.stringify(after).replace(new RegExp(KEY, "g"), "***").slice(0, 200)}`);
console.log("\nDone. Send me everything above – your key isn't shown.");
