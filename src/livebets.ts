// Today's posted bets (NAP, singles, double, treble and every acca with a game today), cached for
// 30 minutes – the 5-minute live runs read this instead of listing storage each time (the free
// plan allows 1,000 storage listings a day).

import { dublinDate } from "./discord";
import type { StoredAcca, StoredAccaLeg } from "./store";

export interface LiveBet { key: string; acca: StoredAcca }

export async function todaysBets(kv: KVNamespace, now = new Date()): Promise<LiveBet[]> {
  const today = dublinDate(now);
  const cacheKey = `livebets:${today}`;
  const cached = await kv.get<{ at: number; bets: LiveBet[] }>(cacheKey, "json");
  if (cached && now.getTime() - cached.at < 30 * 60e3) return cached.bets;

  const bets: LiveBet[] = [];
  for (let i = 0; i <= 3; i++) { // bets settle on the day of their last game – up to Sunday for a Friday acca
    const day = dublinDate(new Date(now.getTime() + i * 864e5));
    const list = await kv.list({ prefix: `acca:${day}:` });
    for (const k of list.keys) {
      const acca = await kv.get<StoredAcca>(k.name, "json");
      if (acca && acca.date <= today && acca.legs.some((l) => dublinDate(new Date(l.kickOff)) === today)) bets.push({ key: k.name, acca });
    }
  }
  await kv.put(cacheKey, JSON.stringify({ at: now.getTime(), bets }), { expirationTtl: 2 * 86400 });
  return bets;
}

// Every game in today's bets, once each
export function betGames(bets: LiveBet[], today: string): StoredAccaLeg[] {
  const seen = new Map<string, StoredAccaLeg>();
  for (const b of bets) for (const l of b.acca.legs) {
    if (dublinDate(new Date(l.kickOff)) !== today) continue;
    seen.set(`${l.code}:${l.homeId}:${l.awayId}`, l);
  }
  return [...seen.values()].sort((a, b) => a.kickOff.localeCompare(b.kickOff));
}
