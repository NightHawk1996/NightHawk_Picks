// Backtest – replays every game of last season and this season so far, predicting each one
// using ONLY the games played before it, exactly as Hawk would have on the day. Then it
// compares Hawk with what happened, and with the bookmakers' favourite.
//
// Runs on your PC (it's far too much work for Cloudflare's free plan) and saves a summary
// that #model-check shows. Usage, from the project folder:
//   node scripts/backtest.mjs
//   npx wrangler kv key put backtest:summary --path backtest.json --binding HAWK --remote
//
// Data: football-data.co.uk (free). Needs Node 23.6 or newer (it reads Hawk's .ts files directly).

import { writeFileSync } from "node:fs";
import { buildRatings, predict } from "../src/model.ts";
import { parseCsv, seasonCode, seasonLabel } from "../src/csv.ts";
import { buildCountRatings, expectedCounts, setPieceLegs, gradeSetPiece, countDist, totalDist, over } from "../src/setpieces.ts";

const LEAGUES = { PL: ["E0", "Premier League"], ELC: ["E1", "Championship"], PD: ["SP1", "La Liga"], SA: ["I1", "Serie A"], BL1: ["D1", "Bundesliga"], FL1: ["F1", "Ligue 1"] };
const VALUE_EDGE = 0.05; // Hawk at least 5 points above the bookies' (margin-free) chance
const BANDS = [[0.9, "90%+"], [0.8, "80–89%"], [0.7, "70–79%"], [0.6, "60–69%"], [0.5, "50–59%"]];

const now = new Date();
// Seasons: warm-up (ratings only) → "find" (search for edges) → last → this season so far.
const warmUp = seasonCode(now, 3), find = seasonCode(now, 2), last = seasonCode(now, 1), current = seasonCode(now, 0);
console.log(`Backtest: ${seasonLabel(last)} and ${seasonLabel(current)} so far (${seasonLabel(warmUp)} and ${seasonLabel(find)} used to warm up and to search for edges)\n`);

// Every spot where Hawk and the bookies disagree, for the "where's the edge?" search.
const spots = [];
// Corners and cards calibration, and whether knowing the referee helps.
const sp = { corners: Object.fromEntries(BANDS.map(([, l]) => [l, [0, 0, 0]])), cards: Object.fromEntries(BANDS.map(([, l]) => [l, [0, 0, 0]])), spread: { corners: [], cards: [] }, ref: { games: 0, withRef: 0, without: 0 } };
const summary = { generated: now.toISOString(), seasons: [last, current], valueEdge: VALUE_EDGE, leagues: {}, bands: Object.fromEntries(BANDS.map(([, l]) => [l, [0, 0, 0]])) };

for (const [code, [div, name]] of Object.entries(LEAGUES)) {
  const rows = [];
  for (const season of [warmUp, find, last, current]) {
    const res = await fetch(`https://www.football-data.co.uk/mmz4281/${season}/${div}.csv`, { headers: { "User-Agent": "NightHawkPicks/1.0 (personal use)" } });
    if (!res.ok) { console.log(`  (no ${seasonLabel(season)} file for ${name} – ${res.status})`); continue; }
    for (const r of parseCsv(await res.text())) rows.push({ season, r });
  }
  rows.sort((a, b) => a.r[0].localeCompare(b.r[0]));
  const asMatch = ({ r }) => ({ utcDate: `${r[0]}T15:00:00Z`, status: "FINISHED", homeTeam: { id: r[1], name: r[1] }, awayTeam: { id: r[2], name: r[2] }, score: { fullTime: { home: r[3], away: r[4] } } });

  const L = { games: 0, hawkRight: 0, bookiesRight: 0, bookiesGames: 0, value: { bets: 0, won: 0, profit: 0 } };
  let i = 0;
  while (i < rows.length) {
    const day = rows[i].r[0];
    const today = [];
    while (i < rows.length && rows[i].r[0] === day) today.push(rows[i++]);
    if (today[0].season === warmUp) continue;
    const before = rows.slice(0, i - today.length), dayDate = new Date(`${day}T12:00:00Z`);
    const ratings = buildRatings(before.map(asMatch), dayDate);
    const cornerGames = before.filter(({ r }) => r[5] != null && r[6] != null).map(({ r }) => ({ date: r[0], home: r[1], away: r[2], hv: r[5], av: r[6] }));
    const cardGames = before.filter(({ r }) => r[7] != null && r[8] != null).map(({ r }) => ({ date: r[0], home: r[1], away: r[2], hv: r[7] + (r[9] ?? 0), av: r[8] + (r[10] ?? 0), ref: r[11] || undefined }));
    const cr = cornerGames.length > 60 ? buildCountRatings(cornerGames, dayDate) : null;
    const kr = cardGames.length > 60 ? buildCountRatings(cardGames, dayDate, true) : null;
    for (const { r, season } of today) {
      const [, home, away, hg, ag, , , , , , , , oh, od, oa, mh, md, ma, ov, un, mov, mun] = r;
      const when = season === current ? "this" : season === last ? "last" : "find";
      const scored = when !== "find"; // the headline numbers cover last season and this one
      const p = predict(ratings, { id: home, name: home }, { id: away, name: away }, home, away);
      const outcome = hg > ag ? 0 : hg === ag ? 1 : 2;
      const hawk = [p.home, p.draw, p.away];
      if (scored) L.games++;
      if (scored && hawk.indexOf(Math.max(...hawk)) === outcome) L.hawkRight++;

      // Calibration across every market Hawk prices (50%+ only – those are the ones it'd back)
      if (scored) for (const leg of p.legs) {
        if (leg.p < 0.5) continue;
        const band = BANDS.find(([lo]) => leg.p >= lo);
        const t = summary.bands[band[1]];
        t[0]++; t[1] += leg.p; if (leg.test(hg, ag)) t[2]++;
      }

      // Corners and cards (only where the file has the stats)
      const [, , , , , hc, ac, hy, ay, hrd, ard, ref] = r;
      if (scored && cr && kr && hc != null && ac != null && hy != null && ay != null) {
        const hk = hy + (hrd ?? 0), ak = ay + (ard ?? 0);
        const legs = setPieceLegs(expectedCounts(cr, home, away), cr.spread, expectedCounts(kr, home, away, ref || undefined), kr.spread, home, away);
        for (const leg of legs) {
          if (leg.p < 0.5) continue;
          const t = sp[leg.spec.t][BANDS.find(([lo]) => leg.p >= lo)[1]];
          t[0]++; t[1] += leg.p; if (gradeSetPiece(leg.spec, hc, ac, hk, ak)) t[2]++;
        }
        if (when !== "find") { sp.spread.corners.push(cr.spread); sp.spread.cards.push(kr.spread); }
        // Referee: cards over 3.5 with and without the referee – lower "surprise" score = better
        if (ref && kr.refs.has(ref)) {
          const pOver = (e) => Math.min(0.999, Math.max(0.001, over(totalDist(countDist(e.home, kr.spread), countDist(e.away, kr.spread)), 3.5)));
          const happened = hk + ak > 3.5;
          const surprise = (q) => -Math.log(happened ? q : 1 - q);
          sp.ref.games++;
          sp.ref.withRef += surprise(pOver(expectedCounts(kr, home, away, ref)));
          sp.ref.without += surprise(pOver(expectedCounts(kr, home, away)));
        }
      }

      // Against the bookies (average pre-match odds, margin removed)
      if (oh && od && oa) {
        const odds = [oh, od, oa];
        const raw = odds.map((o) => 1 / o), total = raw.reduce((s, x) => s + x, 0);
        const market = raw.map((x) => x / total);
        if (scored) L.bookiesGames++;
        if (scored && market.indexOf(Math.max(...market)) === outcome) L.bookiesRight++;
        const best = [mh, md, ma];
        ["Home win", "Draw", "Away win"].forEach((name, k) =>
          spots.push({ when, code, market: name, edge: hawk[k] - market[k], avg: odds[k], best: best[k] ?? odds[k], won: k === outcome }));
        for (let k = 0; k < 3 && scored; k++) {
          if (hawk[k] - market[k] >= VALUE_EDGE) {
            L.value.bets++;
            if (k === outcome) { L.value.won++; L.value.profit += odds[k] - 1; } else L.value.profit -= 1;
          }
        }
      }

      // Over / under 2.5 goals
      if (ov && un) {
        const raw = [1 / ov, 1 / un], total = raw[0] + raw[1];
        const hawkOver = p.legs.find((l) => l.label === "Over 2.5 goals").p;
        const goals = hg + ag;
        spots.push({ when, code, market: "Over 2.5", edge: hawkOver - raw[0] / total, avg: ov, best: mov ?? ov, won: goals > 2.5 });
        spots.push({ when, code, market: "Under 2.5", edge: (1 - hawkOver) - raw[1] / total, avg: un, best: mun ?? un, won: goals < 2.5 });
      }
    }
  }
  L.value.profit = Math.round(L.value.profit * 100) / 100;
  summary.leagues[code] = L;
  const pc = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : "–");
  console.log(`${name.padEnd(15)} ${String(L.games).padStart(4)} games · Hawk's pick right ${pc(L.hawkRight, L.games)} · bookies' favourite ${pc(L.bookiesRight, L.bookiesGames)} · value bets ${L.value.bets}, ${L.value.profit >= 0 ? "+" : ""}${L.value.profit} units (${pc(L.value.profit, L.value.bets)} return)`);
}

console.log("\nIs Hawk's 70% really 70%? (every market, 50%+ legs)");
for (const [label, [n, sumP, won]] of Object.entries(summary.bands)) {
  if (n) console.log(`  ${label.padEnd(7)} ${String(n).padStart(6)} legs · landed ${Math.round((100 * won) / n)}% (said ${Math.round((100 * sumP) / n)}%)`);
}
// Corners and cards
const avg = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 1);
for (const [kind, name] of [["corners", "Corners"], ["cards", "Cards"]]) {
  console.log(`\n${name} – is Hawk's 70% really 70%? (50%+ legs · extra variation measured at ${avg(sp.spread[kind]).toFixed(3)})`);
  const rowsOut = Object.entries(sp[kind]).filter(([, t]) => t[0]);
  if (!rowsOut.length) console.log("  No corners/cards data in these files.");
  for (const [label, [n, sumP, won]] of rowsOut) console.log(`  ${label.padEnd(7)} ${String(n).padStart(6)} legs · landed ${Math.round((100 * won) / n)}% (said ${Math.round((100 * sumP) / n)}%)`);
}
if (sp.ref.games) {
  const gain = (100 * (sp.ref.without - sp.ref.withRef)) / sp.ref.without;
  const better = gain >= 0.5; // must be a real improvement, not rounding
  console.log(`\nReferee effect (cards over 3.5, ${sp.ref.games} games with a known referee): ${better ? `✅ helps – predictions ${gain.toFixed(1)}% sharper with the referee` : "❌ doesn't help – Hawk will leave it out"}`);
} else console.log("\nReferee effect: no referee data in these files.");
summary.setpieces = { corners: sp.corners, cards: sp.cards, spread: { corners: avg(sp.spread.corners), cards: avg(sp.spread.cards) }, ref: sp.ref };

// ---------------------------------------------------------------------------
// Where's the edge? Each rule is FOUND on one full season and CHECKED on the next, which the
// search never saw – then this season so far is shown as a live check. To count, a rule must
// win on both full seasons by more than luck could explain. Testing many rules means some
// will win twice by chance, which is why the bar is high.
// ---------------------------------------------------------------------------
const MIN_BETS = 60;
const test = (bets) => {
  const profit = bets.reduce((s, b) => s + (b.won ? b.best - 1 : -1), 0);
  const spread = Math.sqrt(bets.reduce((s, b) => s + (b.best - 1), 0)) || 1; // how much luck alone moves profit
  return { bets: bets.length, profit: Math.round(profit * 10) / 10, roi: bets.length ? profit / bets.length : 0, z: profit / spread };
};
const rules = [];
for (const market of ["Any result", "Home win", "Draw", "Away win", "Over 2.5", "Under 2.5"])
  for (const edge of [0.05, 0.08, 0.1, 0.15]) {
    const pick = (s) => s.edge >= edge && (market === "Any result" ? ["Home win", "Draw", "Away win"].includes(s.market) : s.market === market);
    const found = test(spots.filter((s) => s.when === "find" && pick(s)));
    const check = test(spots.filter((s) => s.when === "last" && pick(s)));
    const live = test(spots.filter((s) => s.when === "this" && pick(s)));
    const verdict = found.bets < MIN_BETS || check.bets < MIN_BETS ? "too few"
      : found.roi > 0 && found.z >= 1 && check.roi > 0 && check.z >= 1.65 ? "held up"
      : found.roi > 0 && found.z >= 1 ? "didn't hold" : "loses";
    rules.push({ market, edge, found, check, live, verdict });
  }
const pct = (x) => `${x >= 0 ? "+" : ""}${Math.round(x * 100)}%`;
const show = (r) => `  ${r.market.padEnd(10)} ${String(Math.round(r.edge * 100)).padStart(2)}+ pts · ${seasonLabel(find)} ${String(r.found.bets).padStart(4)} bets ${pct(r.found.roi).padStart(5)} · ${seasonLabel(last)} ${String(r.check.bets).padStart(4)} bets ${pct(r.check.roi).padStart(5)} · this season ${String(r.live.bets).padStart(3)} bets ${pct(r.live.roi).padStart(5)}`;
console.log(`\nWhere's the edge? (best available price · found on ${seasonLabel(find)}, checked on ${seasonLabel(last)})`);
const tried = rules.filter((r) => r.verdict === "held up" || r.verdict === "didn't hold").sort((a, b) => (b.verdict === "held up") - (a.verdict === "held up") || b.check.roi - a.check.roi);
if (!tried.length) console.log(`  Nothing made money on ${seasonLabel(find)} – no edge over the bookies on these markets.`);
for (const r of tried.slice(0, 12)) console.log(`${show(r)}  ${r.verdict === "held up" ? "✅ held up" : "❌ didn't hold"}`);
console.log("\nFor comparison – every disagreement of 5+ points:");
for (const r of rules.filter((r) => r.edge === 0.05)) console.log(show(r));
summary.edges = rules.filter((r) => r.verdict === "held up").map(({ market, edge, found, check, live }) => ({ market, edge, found, check, live }));
console.log(summary.edges.length
  ? `\n✅ ${summary.edges.length} rule(s) held up across two full seasons – step 18 will only flag value that matches these.`
  : "\n❌ No rule held up across two full seasons – step 18 will show the bookies' % but won't call anything value.");

writeFileSync("backtest.json", JSON.stringify(summary));
console.log("\nSaved backtest.json. Upload it for #model-check with:\n  npx wrangler kv key put backtest:summary --path backtest.json --binding HAWK --remote");
