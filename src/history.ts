// Match history from football-data.co.uk – free spreadsheets of every result, with corners,
// cards, the referee and bookmakers' odds. Used to give Hawk last season as well as this
// one, so early-season ratings aren't built on a handful of games.
//
// The files are refreshed twice a week overnight. Each league's teams are matched to
// football-data.org's team IDs by finding the same game (same day, same score) in both.

import { getMatches, type Match } from "./football";

export const DIVISIONS: Record<string, string> = { PL: "E0", ELC: "E1", PD: "SP1", SA: "I1", BL1: "D1", FL1: "F1" };
const BASE = "https://www.football-data.co.uk/mmz4281";

import { seasonCode, seasonLabel, parseCsv, type HistoryRow } from "./csv";
export { seasonCode, seasonLabel, parseCsv, type HistoryRow };

// ---------------------------------------------------------------------------
// Matching the spreadsheet's team names to football-data.org's team IDs
// ---------------------------------------------------------------------------
const NICK: Record<string, string> = {
  "nott m": "nottingham", wolves: "wolverhampton", "man": "manchester", utd: "united", spurs: "tottenham",
  "sheffield weds": "sheffield wednesday", qpr: "queens park rangers", "west brom": "west bromwich",
  "ath bilbao": "athletic", "ath madrid": "atletico", sociedad: "real sociedad", betis: "real betis",
  "ein frankfurt": "eintracht frankfurt", "m gladbach": "monchengladbach", "fc koln": "koln", "paris sg": "paris saint germain",
  "st etienne": "saint etienne", "st pauli": "st pauli", "inter": "inter", "milan": "milan", "verona": "verona",
};
export function clean(s: string): string {
  let t = s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/['.]/g, " ").replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
  for (const [k, v] of Object.entries(NICK)) t = t.replace(new RegExp(`\\b${k}\\b`, "g"), v);
  return t.replace(/\b(fc|afc|cf|sc|ac|ssc|club|de|cd|rc|ud|sv|vfl|vfb|tsg|bsc|1|as|us|ogc|losc|stade|sl|calcio|hove|albion|and)\b/g, " ").replace(/\s+/g, " ").trim();
}
function similarity(a: string, b: string): number {
  const x = clean(a), y = clean(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const tx = x.split(" "), ty = y.split(" ");
  const shared = tx.filter((t) => ty.some((u) => u === t || (t.length >= 4 && u.startsWith(t)) || (u.length >= 4 && t.startsWith(u)))).length;
  return shared / Math.max(tx.length, ty.length);
}

// Teams are matched by finding the same game in both sources – same day (±1), same score.
export function learnTeamMap(rows: HistoryRow[], apiMatches: Match[], known: Record<string, number> = {}): Record<string, number> {
  const votes = new Map<string, Map<number, number>>();
  const vote = (name: string, id: number, w: number) => {
    const m = votes.get(name) ?? new Map<number, number>();
    m.set(id, (m.get(id) ?? 0) + w);
    votes.set(name, m);
  };
  const finished = apiMatches.filter((m) => m.status === "FINISHED" && m.score?.fullTime?.home != null);
  for (const r of rows) {
    const day = Date.parse(r[0]);
    const same = finished.filter((m) => Math.abs(Date.parse(m.utcDate.slice(0, 10)) - day) <= 864e5 && m.score!.fullTime!.home === r[3] && m.score!.fullTime!.away === r[4]);
    let best: Match | undefined, bestScore = 0;
    for (const m of same) {
      const s = similarity(r[1], m.homeTeam.name) + similarity(r[1], m.homeTeam.shortName ?? "") + similarity(r[2], m.awayTeam.name) + similarity(r[2], m.awayTeam.shortName ?? "");
      if (s > bestScore) { bestScore = s; best = m; }
    }
    if (best && (same.length === 1 || bestScore > 0.5)) {
      vote(r[1], best.homeTeam.id, 1);
      vote(r[2], best.awayTeam.id, 1);
    }
  }
  const map: Record<string, number> = { ...known };
  for (const [name, ids] of votes) {
    const [id, n] = [...ids].sort((a, b) => b[1] - a[1])[0];
    if (n >= 2) map[name] = id; // at least two games agree
  }
  return map;
}

// ---------------------------------------------------------------------------
// Storage and use
// ---------------------------------------------------------------------------
export interface HistoryEnv { HAWK?: KVNamespace; FOOTBALL_DATA_TOKEN: string }

export async function importSeason(env: HistoryEnv, code: string, back: 0 | 1, now = new Date()) {
  if (!env.HAWK) throw new Error("storage not set up");
  const div = DIVISIONS[code];
  if (!div) throw new Error("no history file for this competition");
  const season = seasonCode(now, back);
  const res = await fetch(`${BASE}/${season}/${div}.csv`, { headers: { "User-Agent": "NightHawkPicks/1.0 (personal use)" } });
  if (!res.ok) throw new Error(`history file ${season}/${div} → ${res.status}`);
  const rows = parseCsv(await res.text());

  // This season: learn which name is which team. Last season: reuse what was learned.
  let map: Record<string, number> = (await env.HAWK.get<Record<string, number>>(`teammap:${code}`, "json")) ?? {};
  if (back === 0) {
    map = learnTeamMap(rows, await getMatches(code, env.FOOTBALL_DATA_TOKEN, now), map);
    await env.HAWK.put(`teammap:${code}`, JSON.stringify(map));
  }
  await env.HAWK.put(`history:${code}:${season}`, JSON.stringify(rows));
  const names = new Set(rows.flatMap((r) => [r[1], r[2]]));
  const unmatched = [...names].filter((n) => !(n in map));
  return { season, games: rows.length, teams: names.size, matched: names.size - unmatched.length, unmatched };
}

// History as matches Hawk can rate from – only games before `before` (the live data covers
// the rest), only teams we could identify.
export async function loadHistory(kv: KVNamespace | undefined, code: string, before: Date, now = new Date()): Promise<Match[]> {
  if (!kv || !DIVISIONS[code]) return [];
  const [map, thisSeason, lastSeason] = await Promise.all([
    kv.get<Record<string, number>>(`teammap:${code}`, "json"),
    kv.get<HistoryRow[]>(`history:${code}:${seasonCode(now, 0)}`, "json"),
    kv.get<HistoryRow[]>(`history:${code}:${seasonCode(now, 1)}`, "json"),
  ]);
  if (!map) return [];
  const cutoff = before.toISOString().slice(0, 10);
  const out: Match[] = [];
  for (const r of [...(lastSeason ?? []), ...(thisSeason ?? [])]) {
    if (r[0] >= cutoff) continue;
    const h = map[r[1]], a = map[r[2]];
    if (!h || !a) continue;
    out.push({
      utcDate: `${r[0]}T15:00:00Z`, status: "FINISHED",
      homeTeam: { id: h, name: r[1] }, awayTeam: { id: a, name: r[2] },
      score: { winner: r[3] > r[4] ? "HOME_TEAM" : r[3] < r[4] ? "AWAY_TEAM" : "DRAW", fullTime: { home: r[3], away: r[4] } },
    });
  }
  return out;
}
