// Racing API probe – tries each part of The Racing API with your login and reports what your
// plan can access, so Hawk is built on what you actually have. Prints no credentials.
// Usage (PowerShell), from the project folder:
//   $env:RACING_USER = Read-Host "Racing API username" -MaskInput
//   $env:RACING_PASS = Read-Host "Racing API password" -MaskInput
//   node scripts/racing-probe.mjs

const { RACING_USER, RACING_PASS } = process.env;
if (!RACING_USER || !RACING_PASS) { console.error("Set RACING_USER and RACING_PASS first (see the top of this file)."); process.exit(1); }
const BASE = "https://api.theracingapi.com";
const auth = "Basic " + Buffer.from(`${RACING_USER}:${RACING_PASS}`).toString("base64");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(path) {
  await sleep(1300); // the free plan allows 1 request a second
  const res = await fetch(BASE + path, { headers: { Authorization: auth } });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text: text.slice(0, 220).replace(/\s+/g, " ") };
}
const keysOf = (o) => (o && typeof o === "object" ? Object.keys(o).slice(0, 25).join(", ") : "");
const firstArray = (j) => (Array.isArray(j) ? j : j && Object.values(j).find(Array.isArray)) ?? [];
function report(name, r, extra = "") {
  const planWall = /plan required/i.test(r.text);
  const mark = r.status === 200 ? "✅" : planWall || [402, 403].includes(r.status) ? "🔒 not on your plan" : r.status === 401 ? "🔒 login rejected" : r.status === 429 ? "⏳ too fast (rate limit)" : r.status === 422 ? "⚠️ needs different options" : `❌ ${r.status}`;
  console.log(`\n${mark}  ${name}`);
  if (r.status !== 200) console.log(`   ${r.text}`);
  else if (extra) console.log(extra);
}

console.log("Probing The Racing API with your login…");

// Courses – also finds Cheltenham and Aintree's IDs
const courses = await get("/v1/courses?region_codes=gb");
report("Courses", courses);
const list = firstArray(courses.json);
const cheltenham = list.find((c) => /cheltenham/i.test(c.course ?? c.name ?? ""));
const aintree = list.find((c) => /aintree/i.test(c.course ?? c.name ?? ""));
if (cheltenham) console.log(`   Cheltenham id: ${cheltenham.id} · Aintree id: ${aintree?.id ?? "?"}`);

if (process.argv.includes("--free")) {
  const show = (label, r) => {
    report(label, r);
    const races = firstArray(r.json);
    if (!races.length) return console.log("   (nothing returned – there may be no racing today)");
    console.log(`   ${races.length} races · race fields: ${keysOf(races[0])}`);
    const runner = races[0].runners?.[0];
    if (runner) console.log(`   runner fields: ${keysOf(runner)}`);
    console.log(`   example race: ${JSON.stringify({ ...races[0], runners: undefined }).slice(0, 400)}`);
    if (runner) console.log(`   example runner: ${JSON.stringify(runner).slice(0, 400)}`);
  };
  show("Racecards – free (today)", await get("/v1/racecards/free?day=today"));
  show("Racecards – free (tomorrow)", await get("/v1/racecards/free?day=tomorrow"));
  show("Results – today (free)", await get("/v1/results/today/free"));
  console.log("\nDone. Send a screenshot of everything above – no passwords are shown.");
  process.exit(0);
}

// Racecards at each plan level
for (const level of ["free", "basic", "standard", "pro"]) {
  const r = await get(`/v1/racecards/${level}?day=today`);
  const races = firstArray(r.json);
  const runner = races[0]?.runners?.[0];
  report(`Racecards – ${level}`, r, races.length ? `   ${races.length} races today · race fields: ${keysOf(races[0])}\n   runner fields: ${keysOf(runner)}` : "");
}
report("Big races (upcoming)", await get("/v1/racecards/big-races"));

// Results: today, then last year's Festival, then 10 years back – how far does your plan go?
report("Results – today (free)", await get("/v1/results/today/free?region=gb"));
for (const [label, from, to] of [["Cheltenham Festival 2026", "2026-03-10", "2026-03-13"], ["Cheltenham Festival 2025", "2025-03-11", "2025-03-14"], ["Cheltenham Festival 2018", "2018-03-13", "2018-03-16"]]) {
  const course = cheltenham ? `&course=${cheltenham.id}` : "";
  const r = await get(`/v1/results?start_date=${from}&end_date=${to}${course}&limit=50`);
  const races = firstArray(r.json);
  const runner = races[0]?.runners?.[0];
  report(`Results – ${label}`, r, races.length ? `   ${races.length} races found · race fields: ${keysOf(races[0])}\n   runner fields: ${keysOf(runner)}` : "   (no races returned)");
}

// A horse's form
const horse = await get("/v1/horses/search?name=Galopin%20Des%20Champs");
report("Horse search", horse);
const hid = firstArray(horse.json)[0]?.id;
if (hid) report("Horse results / form", await get(`/v1/horses/${hid}/results`));

console.log("\nDone. Send a screenshot of everything above – no passwords are shown.");
