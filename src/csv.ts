// Reading football-data.co.uk's spreadsheets. No imports, so the backtest script on your
// PC can use it too.

// 2026/27 → "2627". `back` = how many seasons back (0 = this season).
export function seasonCode(now: Date, back = 0): string {
  const y = now.getUTCFullYear() % 100, startYear = now.getUTCMonth() >= 6 ? y : y - 1;
  const s = startYear - back;
  return `${String(s).padStart(2, "0")}${String(s + 1).padStart(2, "0")}`;
}
export const seasonLabel = (code: string) => `20${code.slice(0, 2)}/${code.slice(2)}`;

// One compact row per game: [date, home, away, homeGoals, awayGoals, homeCorners, awayCorners,
// homeYellows, awayYellows, homeReds, awayReds, referee, avgHomeOdds, avgDrawOdds, avgAwayOdds,
// bestHomeOdds, bestDrawOdds, bestAwayOdds, avgOver2.5, avgUnder2.5, bestOver2.5, bestUnder2.5]
type N = number | null;
export type HistoryRow = [string, string, string, number, number, N, N, N, N, N, N, string, N, N, N, N, N, N, N, N, N, N];

export function parseCsv(text: string): HistoryRow[] {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return [];
  const head = lines[0].split(",").map((h) => h.trim());
  const col = (...names: string[]) => names.map((n) => head.indexOf(n)).find((i) => i >= 0) ?? -1;
  const c = {
    date: col("Date"), home: col("HomeTeam", "Home", "HT"), away: col("AwayTeam", "Away", "AT"),
    hg: col("FTHG", "HG"), ag: col("FTAG", "AG"), hc: col("HC"), ac: col("AC"),
    hy: col("HY"), ay: col("AY"), hr: col("HR"), ar: col("AR"), ref: col("Referee"),
    oh: col("AvgH", "BbAvH", "B365H", "PSH"), od: col("AvgD", "BbAvD", "B365D", "PSD"), oa: col("AvgA", "BbAvA", "B365A", "PSA"),
    mh: col("MaxH", "BbMxH"), md: col("MaxD", "BbMxD"), ma: col("MaxA", "BbMxA"),
    ov: col("Avg>2.5", "BbAv>2.5", "B365>2.5"), un: col("Avg<2.5", "BbAv<2.5", "B365<2.5"),
    mov: col("Max>2.5", "BbMx>2.5"), mun: col("Max<2.5", "BbMx<2.5"),
  };
  if (c.date < 0 || c.home < 0 || c.away < 0 || c.hg < 0 || c.ag < 0) throw new Error("unexpected file layout");
  const num = (v?: string) => (v === undefined || v.trim() === "" || isNaN(Number(v)) ? null : Number(v));
  const rows: HistoryRow[] = [];
  for (const line of lines.slice(1)) {
    const f = line.split(",");
    const hg = num(f[c.hg]), ag = num(f[c.ag]);
    if (hg === null || ag === null || !f[c.home]) continue; // not played yet
    const [d, m, yRaw] = (f[c.date] ?? "").split("/");
    if (!d || !m || !yRaw) continue;
    const y = yRaw.length === 2 ? `20${yRaw}` : yRaw;
    rows.push([
      `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`, f[c.home].trim(), f[c.away].trim(), hg, ag,
      num(f[c.hc]), num(f[c.ac]), num(f[c.hy]), num(f[c.ay]), num(f[c.hr]), num(f[c.ar]),
      c.ref >= 0 ? (f[c.ref] ?? "").trim() : "", num(f[c.oh]), num(f[c.od]), num(f[c.oa]),
      num(f[c.mh]), num(f[c.md]), num(f[c.ma]), num(f[c.ov]), num(f[c.un]), num(f[c.mov]), num(f[c.mun]),
    ]);
  }
  return rows;
}

