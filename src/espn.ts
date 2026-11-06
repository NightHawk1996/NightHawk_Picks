// Corners and cards for finished matches from ESPN's public app data, so builder legs on corners
// and cards settle the next morning instead of waiting for the twice-weekly history files.
// Unofficial: no key, and ESPN's terms don't cover this use – the owner accepted that for this
// private server. If ESPN changes or blocks it, legs simply wait for football-data.co.uk.

import { clean } from "./history";

const BASE = "https://site.api.espn.com/apis/site/v2/sports/soccer";
export const ESPN_SLUG: Record<string, string> = {
  PL: "eng.1", ELC: "eng.2", PD: "esp.1", SA: "ita.1", BL1: "ger.1", FL1: "fra.1",
  CL: "uefa.champions", EL: "uefa.europa", ECL: "uefa.europa.conf",
};
const KEEP_SECONDS = 60 * 86400;

export interface CountStats { hc: number; ac: number; hk: number; ak: number }
interface EspnGame { id: string; done: boolean; teams: { id: string; side: "home" | "away"; name: string }[] }

async function espnText(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" } });
    return res.ok ? await res.text() : null;
  } catch { return null; }
}

// One league's games on one day (memo kept for 10 minutes so a results run fetches each once)
const boards = new Map<string, { at: number; games: EspnGame[] | null }>();
async function scoreboard(slug: string, ymd: string): Promise<EspnGame[] | null> {
  const key = `${slug}:${ymd}`, hit = boards.get(key);
  if (hit && Date.now() - hit.at < 600_000) return hit.games;
  const text = await espnText(`${BASE}/${slug}/scoreboard?dates=${ymd}`);
  let games: EspnGame[] | null = null;
  if (text) {
    const j = JSON.parse(text);
    games = (j.events ?? []).map((e: any) => ({
      id: String(e.id),
      done: !!e.status?.type?.completed,
      teams: (e.competitions?.[0]?.competitors ?? []).map((c: any) => ({ id: String(c.team?.id ?? c.id), side: c.homeAway, name: c.team?.displayName ?? c.team?.name ?? "" })),
    }));
  }
  boards.set(key, { at: Date.now(), games });
  return games;
}

// Word overlap between two team names after removing "FC", accents and nicknames
export function nameMatch(a: string, b: string): number {
  const x = clean(a).split(" ").filter(Boolean), y = clean(b).split(" ").filter(Boolean);
  if (!x.length || !y.length) return 0;
  const shared = x.filter((t) => y.some((u) => u === t || (t.length >= 4 && u.startsWith(t)) || (u.length >= 4 && t.startsWith(u)))).length;
  return shared / Math.max(x.length, y.length);
}

export function findGame(games: EspnGame[], home: string, away: string): EspnGame | undefined {
  let best: EspnGame | undefined, bestScore = 0;
  for (const g of games) {
    const h = g.teams.find((t) => t.side === "home"), a = g.teams.find((t) => t.side === "away");
    if (!h || !a) continue;
    const mh = nameMatch(home, h.name), ma = nameMatch(away, a.name);
    // Both names must agree, and the game mustn't fit better the other way round
    // (Man City v Man United share "Man" – the reverse fixture would otherwise look close)
    if (mh < 0.5 || ma < 0.5) continue;
    if (nameMatch(home, a.name) + nameMatch(away, h.name) >= mh + ma) continue;
    if (mh + ma > bestScore) { best = g; bestScore = mh + ma; }
  }
  return best;
}

// Reads corners, yellows and reds straight out of the match summary text. The summary is large
// (commentary, line-ups…), and parsing it all would eat the Worker's CPU allowance.
export function statsFromSummary(text: string, game: EspnGame): CountStats | null {
  const start = text.indexOf('"boxscore"');
  if (start < 0) return null;
  const end = text.indexOf('"gameInfo"', start);
  const box = text.slice(start, end > start ? end : start + 60000);
  const blocks = box.split(/\{"team":\{/).slice(1);
  const out: Partial<Record<"home" | "away", { c: number; y: number; r: number }>> = {};
  for (const b of blocks) {
    const id = b.match(/^[^{}]*?"id":"(\d+)"/)?.[1];
    const side = game.teams.find((t) => t.id === id)?.side ?? (b.match(/"homeAway":"(home|away)"/)?.[1] as "home" | "away" | undefined);
    if (!side) continue;
    const stat = (name: string) => {
      const obj = b.match(new RegExp(`\\{[^{}]*"name":"${name}"[^{}]*\\}`))?.[0];
      const v = obj?.match(/"displayValue":"(\d+)"/)?.[1];
      return v === undefined ? NaN : Number(v);
    };
    out[side] = { c: stat("wonCorners"), y: stat("yellowCards"), r: stat("redCards") };
  }
  const h = out.home, a = out.away;
  if (!h || !a || [h.c, a.c, h.y, a.y].some(Number.isNaN)) return null;
  return { hc: h.c, ac: a.c, hk: h.y + (h.r || 0), ak: a.y + (a.r || 0) }; // cards = yellows + reds, as in the history files
}

export async function espnStats(kv: KVNamespace | undefined, code: string, kickOff: string, home: string, away: string): Promise<CountStats | null> {
  const slug = ESPN_SLUG[code];
  if (!slug || !home || !away) return null;
  const ymd = kickOff.slice(0, 10).replace(/-/g, "");
  const games = await scoreboard(slug, ymd);
  const game = games && findGame(games, home, away);
  if (!game || !game.done) return null;
  const cacheKey = `espn:${code}:${game.id}`;
  const cached = kv ? await kv.get<CountStats>(cacheKey, "json") : null;
  if (cached) return cached;
  const text = await espnText(`${BASE}/${slug}/summary?event=${game.id}`);
  const stats = text ? statsFromSummary(text, game) : null;
  if (stats && kv) await kv.put(cacheKey, JSON.stringify(stats), { expirationTtl: KEEP_SECONDS });
  return stats;
}
