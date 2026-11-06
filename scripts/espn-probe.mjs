// ESPN probe – checks ESPN's app data has corners and cards for finished matches in Hawk's leagues.
// No key or login needed. Usage: node scripts/espn-probe.mjs [YYYYMMDD]   (default: 1 Nov 2026)

const date = process.argv[2] ?? "20261101";
const LEAGUES = { PL: "eng.1", ELC: "eng.2", PD: "esp.1", SA: "ita.1", BL1: "ger.1", FL1: "fra.1", CL: "uefa.champions", EL: "uefa.europa", ECL: "uefa.europa.conf" };
const BASE = "https://site.api.espn.com/apis/site/v2/sports/soccer";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = async (url) => {
  await sleep(800);
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) { console.log(`  ❌ ${res.status} ${url}\n     ${(await res.text()).slice(0, 200).replace(/\s+/g, " ")}`); return null; }
  return res.json();
};

// 1. Which leagues have finished games – one day at a time over the 5 days from that date
const days = Array.from({ length: 5 }, (_, i) => { const d = new Date(Date.UTC(+date.slice(0, 4), +date.slice(4, 6) - 1, +date.slice(6, 8) + i)); return d.toISOString().slice(0, 10).replace(/-/g, ""); });
let sample = null;
for (const [code, slug] of Object.entries(LEAGUES)) {
  const done = [];
  let ok = false;
  for (const d of days) {
    const sb = await get(`${BASE}/${slug}/scoreboard?dates=${d}`);
    if (sb) ok = true;
    done.push(...(sb?.events ?? []).filter((e) => e.status?.type?.completed));
    if (!sb && d === days[0]) break; // first day failed – don't hammer it
  }
  console.log(`${code.padEnd(4)} ${slug.padEnd(17)} ${ok ? `${done.length} finished games found` : ""}`);
  if (done.length && (!sample || code === "PL")) sample = sample?.code === "PL" ? sample : { code, slug, ev: done[0] };
}

// 2. One finished match's team stats
if (sample) {
  const s = await get(`${BASE}/${sample.slug}/summary?event=${sample.ev.id}`);
  console.log(`\n📋 ${sample.ev.name} (${sample.ev.date})`);
  for (const t of s?.boxscore?.teams ?? []) {
    const st = Object.fromEntries((t.statistics ?? []).map((x) => [x.name, x.displayValue]));
    console.log(`   ${t.team?.displayName}: corners ${st.wonCorners ?? "?"} · yellows ${st.yellowCards ?? "?"} · reds ${st.redCards ?? "?"}`);
  }
  const names = (s?.boxscore?.teams?.[0]?.statistics ?? []).map((x) => x.name);
  console.log(`   all stat names: ${names.join(", ")}`);
  const ref = (s?.gameInfo?.officials ?? [])[0];
  console.log(`   referee: ${ref?.displayName ?? ref?.fullName ?? "not listed"}`);
}
console.log("\nDone – send me everything above.");
