// Hawk's daily acca: the strongest legs (80%+) from today's games across every league,
// one leg per game. Games in different matches don't affect each other, so here
// multiplying the legs together is the honest combined chance.

import { COLOUR, LEAGUES } from "./football";
import { pct, fairOdds } from "./model";
import type { StoredDay, StoredAcca, StoredAccaLeg } from "./store";

const MAX_LEGS = 6;
const MIN_LEGS = 3;
const LONG_SHOT = 0.3; // below this, also offer a safer 4-leg version

const preference = (l: { spec: { t: string; v?: string } }) =>
  l.spec.t === "res" && (l.spec.v === "H" || l.spec.v === "A") ? 2 : l.spec.t === "res" ? 1 : 0;

export function buildAcca(days: StoredDay[], date: string, now: Date): StoredAcca | null {
  const candidates: StoredAccaLeg[] = [];
  for (const day of days) {
    for (const g of day.games) {
      if (new Date(g.kickOff) <= now) continue; // already started
      // Best 80%+ leg for this game: a straight win first (the classic acca), then a
      // double chance, and only then another market.
      const best = [...g.strong].sort((x, y) => preference(y) - preference(x) || y.p - x.p)[0];
      if (!best) continue;
      candidates.push({
        label: best.label, p: best.p, spec: best.spec,
        code: day.code, homeId: g.homeId, awayId: g.awayId, home: g.home, away: g.away, kickOff: g.kickOff, postedAt: day.postedAt,
      });
    }
  }
  if (candidates.length < MIN_LEGS) return null;

  // Wins before double chances before other markets, then the most likely first.
  const ranked = candidates.sort((x, y) => preference(y) - preference(x) || y.p - x.p);
  const legs = ranked.slice(0, MAX_LEGS);
  const product = (ls: StoredAccaLeg[]) => ls.reduce((s, l) => s * l.p, 1);
  const p = product(legs);
  const safest = [...legs].sort((x, y) => y.p - x.p).slice(0, 4);
  const safer = p < LONG_SHOT && legs.length > 4 ? { legs: safest, p: product(safest) } : null;
  const sortByTime = (ls: StoredAccaLeg[]) => [...ls].sort((x, y) => x.kickOff.localeCompare(y.kickOff));
  return { date, postedAt: now.toISOString(), legs: sortByTime(legs), p, safer: safer && { legs: sortByTime(safer.legs), p: safer.p } };
}

const DAY = new Intl.DateTimeFormat("en-IE", { weekday: "long", day: "numeric", month: "long", timeZone: "Europe/Dublin" });
const unix = (iso: string) => Math.floor(new Date(iso).getTime() / 1000);

export function accaEmbed(acca: StoredAcca | null, now: Date) {
  const title = `🎟️ Hawk's Acca – ${DAY.format(now)}`;
  if (!acca) {
    return {
      title,
      description: `No acca today – Hawk needs at least ${MIN_LEGS} legs it rates at **80% or more**, and today's games don't have enough.\n\nNo acca is better than a weak one. 🦅`,
      color: COLOUR,
      footer: { text: "Powered by Hawk 🦅" },
    };
  }
  const line = (l: StoredAccaLeg, i: number) =>
    `**${i + 1}.** ${LEAGUES[l.code]?.emoji ?? "⚽"} ${l.home} v ${l.away} · <t:${unix(l.kickOff)}:t>\n　**${l.label}** – ${pct(l.p)}`;
  const parts = [
    acca.legs.map(line).join("\n"),
    "",
    `**Together: ${pct(acca.p)}** – worth it at **${fairOdds(acca.p)}** or bigger`,
    `_Every leg has to land – ${acca.legs.length} legs at these chances come to ${pct(acca.p)} together._`,
  ];
  if (acca.safer) {
    parts.push(
      "",
      "🛡️ **Safer 4-leg version**",
      acca.safer.legs.map((l) => `• ${l.home} v ${l.away} – **${l.label}** (${pct(l.p)})`).join("\n"),
      `**Together: ${pct(acca.safer.p)}** – worth it at **${fairOdds(acca.safer.p)}** or bigger`,
    );
  }
  return {
    title,
    description: parts.join("\n"),
    color: COLOUR,
    footer: { text: "One leg per game, 80%+ each · Results in #results tomorrow · Powered by Hawk 🦅" },
  };
}

// 🔍 Why? for acca legs – each option points at the league post the leg came from.
export function accaWhyMenu(acca: StoredAcca | null) {
  if (!acca) return [];
  return [{
    type: 1,
    components: [{
      type: 3,
      custom_id: `why:ac:${acca.date}`,
      placeholder: "🔍 Why? Pick a leg to see Hawk's reasoning",
      options: acca.legs.map((l) => ({
        label: `${l.home} v ${l.away}`.slice(0, 100),
        value: `${l.code}:${unix(l.postedAt)}:${l.homeId}-${l.awayId}`,
        description: `${l.label} – ${pct(l.p)}`.slice(0, 100),
      })),
    }],
  }];
}
