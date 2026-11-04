// Bookmakers' prices from The Odds API (free plan: 500 credits a month, no card).
// Only the 9am league runs spend credits – one call per league per day, and only when that
// league has games (a call that finds no games costs nothing). Everything else reuses the
// morning's prices from storage.
//
// Hawk's own chances are never blended with these. They're shown side by side.

import { clean } from "./history";
import type { Match } from "./football";

export const SPORTS: Record<string, string> = {
  PL: "soccer_epl",
  ELC: "soccer_efl_champ",
  PD: "soccer_spain_la_liga",
  SA: "soccer_italy_serie_a",
  BL1: "soccer_germany_bundesliga",
  FL1: "soccer_france_ligue_one",
  CL: "soccer_uefa_champs_league",
};

// One game's prices. Chances have the bookies' margin taken out and are averaged across
// UK bookmakers; "best" is the biggest price on offer anywhere.
export interface GameOdds {
  home: string; away: string; kickOff: string; books: number;
  chance: { H: number; D: number; A: number; over?: number; under?: number };
  best: { H: number; D: number; A: number; over?: number; under?: number };
}

export async function fetchOdds(apiKey: string, code: string, from: Date, to: Date) {
  const sport = SPORTS[code];
  if (!sport) return { games: [] as GameOdds[], remaining: null as string | null };
  const iso = (d: Date) => d.toISOString().slice(0, 19) + "Z";
  const url = `https://api.the-odds-api.com/v4/sports/${sport}/odds?apiKey=${apiKey}&regions=uk&markets=h2h,totals&oddsFormat=decimal&commenceTimeFrom=${iso(from)}&commenceTimeTo=${iso(to)}`;
  const res = await fetch(url);
  if (res.status === 401) throw new Error("odds key rejected – check the ODDS_API_KEY secret");
  if (res.status === 429) throw new Error("odds limit reached for this month");
  if (!res.ok) throw new Error(`odds error ${res.status}`);
  const events: any[] = await res.json();
  return { games: events.map(summarise).filter((g): g is GameOdds => !!g), remaining: res.headers.get("x-requests-remaining") };
}

function summarise(ev: any): GameOdds | null {
  const h2h: number[][] = [], totals: number[][] = [];
  const best = { H: 0, D: 0, A: 0, over: 0, under: 0 };
  for (const book of ev.bookmakers ?? []) {
    for (const m of book.markets ?? []) {
      if (m.key === "h2h") {
        const price = (name: string) => m.outcomes.find((o: any) => o.name === name)?.price;
        const [h, d, a] = [price(ev.home_team), price("Draw"), price(ev.away_team)];
        if (!h || !d || !a) continue;
        h2h.push([h, d, a]);
        best.H = Math.max(best.H, h); best.D = Math.max(best.D, d); best.A = Math.max(best.A, a);
      }
      if (m.key === "totals") {
        const o = m.outcomes.find((x: any) => x.name === "Over" && x.point === 2.5)?.price;
        const u = m.outcomes.find((x: any) => x.name === "Under" && x.point === 2.5)?.price;
        if (!o || !u) continue;
        totals.push([o, u]);
        best.over = Math.max(best.over, o); best.under = Math.max(best.under, u);
      }
    }
  }
  if (!h2h.length) return null;
  // Take each bookmaker's margin out, then average them
  const fair = (prices: number[][]) => {
    const sums = prices[0].map(() => 0);
    for (const p of prices) {
      const raw = p.map((x) => 1 / x), t = raw.reduce((s, x) => s + x, 0);
      raw.forEach((x, i) => (sums[i] += x / t));
    }
    return sums.map((x) => x / prices.length);
  };
  const [H, D, A] = fair(h2h);
  const ou = totals.length ? fair(totals) : null;
  return {
    home: ev.home_team, away: ev.away_team, kickOff: ev.commence_time, books: h2h.length,
    chance: { H, D, A, ...(ou ? { over: ou[0], under: ou[1] } : {}) },
    best: { H: best.H, D: best.D, A: best.A, ...(ou ? { over: best.over, under: best.under } : {}) },
  };
}

// Matching a game in the odds to one of Hawk's fixtures: kick-off within 3 hours, and the
// team names agreeing (the two sources spell them differently).
const words = (s: string) => clean(s).split(" ").filter(Boolean);
function nameMatch(a: string, b: string) {
  const x = words(a), y = words(b);
  return x.some((t) => y.some((u) => u === t || (t.length >= 4 && u.startsWith(t)) || (u.length >= 4 && t.startsWith(u))));
}
export function oddsFor(m: Match, games: GameOdds[]): GameOdds | undefined {
  const t = Date.parse(m.utcDate);
  return games.find((g) => Math.abs(Date.parse(g.kickOff) - t) <= 3 * 3600e3
    && (nameMatch(g.home, m.homeTeam.name) || nameMatch(g.home, m.homeTeam.shortName ?? ""))
    && (nameMatch(g.away, m.awayTeam.name) || nameMatch(g.away, m.awayTeam.shortName ?? "")));
}

// Storage: the morning's prices, reused by commands and 🔍 Why? for the rest of the day.
export async function saveOdds(kv: KVNamespace, code: string, games: GameOdds[]) {
  await kv.put(`odds:${code}`, JSON.stringify({ at: new Date().toISOString(), games }), { expirationTtl: 60 * 60 * 24 * 4 });
}
export async function loadOdds(kv: KVNamespace | undefined, code: string): Promise<GameOdds[]> {
  if (!kv) return [];
  return (await kv.get<{ games: GameOdds[] }>(`odds:${code}`, "json"))?.games ?? [];
}

// ---------------------------------------------------------------------------
// Where the bookies' price is bigger than Hawk's fair price
// ---------------------------------------------------------------------------
export const GAP = 0.08; // Hawk 8+ points above the bookies
export interface Disagreement { side: "H" | "D" | "A" | "over" | "under"; label: string; hawk: number; bookies: number; best: number }

export function disagreements(hawk: { H: number; D: number; A: number; over: number }, odds: GameOdds, names: { home: string; away: string }): Disagreement[] {
  const out: Disagreement[] = [];
  const check = (side: Disagreement["side"], label: string, h: number, b?: number, best?: number) => {
    if (b === undefined || !best) return;
    if (h - b >= GAP && h >= 0.25) out.push({ side, label, hawk: h, bookies: b, best });
  };
  check("H", `${names.home} win`, hawk.H, odds.chance.H, odds.best.H);
  check("D", "Draw", hawk.D, odds.chance.D, odds.best.D);
  check("A", `${names.away} win`, hawk.A, odds.chance.A, odds.best.A);
  check("over", "Over 2.5 goals", hawk.over, odds.chance.over, odds.best.over);
  check("under", "Under 2.5 goals", 1 - hawk.over, odds.chance.under, odds.best.under);
  return out;
}
