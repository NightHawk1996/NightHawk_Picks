// Saves every pick Hawk posts, in a form #results can check against the final score.
// Uses Cloudflare KV (free tier). Keys:
//   picks:<date>:<league>  – each game's pick, bet builder and strongest legs
//   acca:<date>            – the day's acca

import type { LegSpec, Leg } from "./model";
import type { Match, Predicted } from "./football";

export interface StoredLeg { label: string; p: number; spec: LegSpec }
export interface StoredGame {
  homeId: number;
  awayId: number;
  home: string;
  away: string;
  kickOff: string;
  pick: StoredLeg;
  builder: { p: number; legs: StoredLeg[] } | null;
  strong: (StoredLeg & { family: string })[]; // 80%+ legs, candidates for the acca
  gaps?: (StoredLeg & { bookies: number; best: number })[]; // 📊 bookies' price bigger than Hawk's fair price
  oh?: string; oa?: string; // the bookies' spelling of the teams, for finding prices later ("Hamburger SV" for HSV)
}
export interface StoredDay { code: string; date: string; postedAt: string; games: StoredGame[] }
export interface StoredAccaLeg extends StoredLeg { code: string; homeId: number; awayId: number; home: string; away: string; kickOff: string; postedAt: string; oh?: string; oa?: string }
export type AccaKind = "daily" | "weekend" | "around" | "clweek" | "clnight";
export interface StoredAcca {
  kind?: AccaKind; // missing on accas saved before step 14 = daily
  date: string; // day it was posted
  settleDate?: string; // day of its last game – #results grades it the morning after
  postedAt: string;
  legs: StoredAccaLeg[];
  p: number;
  safer: { legs: StoredAccaLeg[]; p: number } | null;
}

const leg = (l: Leg): StoredLeg => ({ label: l.label, p: Math.round(l.p * 1000) / 1000, spec: l.spec });
const TTL = 60 * 60 * 24 * 120; // keep 120 days, plenty for weekly model checks

export function toStoredGames(list: { m: Match; p: Predicted }[]): StoredGame[] {
  return list.map(({ m, p }) => {
    const options = [
      { side: "H" as const, label: `${p.homeName} win`, p: p.home },
      { side: "D" as const, label: "Draw", p: p.draw },
      { side: "A" as const, label: `${p.awayName} win`, p: p.away },
    ];
    const best = options.reduce((x, y) => (y.p > x.p ? y : x));
    return {
      homeId: m.homeTeam.id,
      awayId: m.awayTeam.id,
      home: p.homeName,
      away: p.awayName,
      kickOff: m.utcDate,
      ...(p.odds ? { oh: p.odds.home, oa: p.odds.away } : {}),
      pick: { label: best.label, p: Math.round(best.p * 1000) / 1000, spec: { t: "res", v: best.side } },
      builder: p.builder ? { p: Math.round(p.builder.p * 1000) / 1000, legs: p.builder.legs.map(leg) } : null,
      strong: p.legs
        .filter((l) => l.p >= 0.8 && l.p < 0.95)
        .sort((x, y) => y.p - x.p)
        .map((l) => ({ ...leg(l), family: l.family })),
      gaps: p.gaps.map((g) => ({
        label: g.label, p: Math.round(g.hawk * 1000) / 1000, bookies: Math.round(g.bookies * 1000) / 1000, best: g.best,
        spec: (g.side === "over" ? { t: "tot", op: ">", x: 2.5 } : g.side === "under" ? { t: "tot", op: "<", x: 2.5 } : { t: "res", v: g.side }) as LegSpec,
      })),
    };
  });
}

export async function savePicks(kv: KVNamespace, day: StoredDay) {
  await kv.put(`picks:${day.date}:${day.code}`, JSON.stringify(day), { expirationTtl: TTL });
}

export async function loadPicks(kv: KVNamespace, date: string): Promise<StoredDay[]> {
  const list = await kv.list({ prefix: `picks:${date}:` });
  const days = await Promise.all(list.keys.map((k) => kv.get<StoredDay>(k.name, "json")));
  return days.filter((d): d is StoredDay => !!d);
}

// Saved under the day of its last game, so #results finds it the next morning.
export async function saveAcca(kv: KVNamespace, acca: StoredAcca) {
  await kv.put(`acca:${acca.settleDate ?? acca.date}:${acca.kind ?? "daily"}`, JSON.stringify(acca), { expirationTtl: TTL });
}

export async function loadAccasSettling(kv: KVNamespace, date: string): Promise<StoredAcca[]> {
  const list = await kv.list({ prefix: `acca:${date}` });
  const accas = await Promise.all(list.keys.map((k) => kv.get<StoredAcca>(k.name, "json")));
  return accas.filter((a): a is StoredAcca => !!a);
}

// Games further ahead (weekend / Champions League week), saved by the league runs.
export async function saveAhead(kv: KVNamespace, day: StoredDay) {
  await kv.put(`ahead:${day.date}:${day.code}`, JSON.stringify(day), { expirationTtl: 60 * 60 * 24 * 14 });
}
export async function loadAhead(kv: KVNamespace, date: string, code?: string): Promise<StoredDay[]> {
  const list = await kv.list({ prefix: `ahead:${date}:${code ?? ""}` });
  const days = await Promise.all(list.keys.map((k) => kv.get<StoredDay>(k.name, "json")));
  return days.filter((d): d is StoredDay => !!d);
}
