// Hawk's accas. All of them follow the same rules:
//   • one leg per game, each 80%+
//   • a straight win first (the classic acca), then a double chance, then other markets
//   • at most 6 legs, at least 3 – no acca is better than a weak one
//   • a safer 4-leg version when the full acca is under 30%
// Legs from different games don't affect each other, so multiplying them is the honest
// combined chance.

import { COLOUR, LEAGUES } from "./football";
import { pct, fairOdds } from "./model";
import type { StoredDay, StoredAcca, StoredAccaLeg, AccaKind, StoredGame } from "./store";

const MAX_LEGS = 6;
const MIN_LEGS = 3;
const LONG_SHOT = 0.3;

const preference = (l: { spec: { t: string; v?: string } }) =>
  l.spec.t === "res" && (l.spec.v === "H" || l.spec.v === "A") ? 2 : l.spec.t === "res" ? 1 : 0;
const rank = (x: StoredAccaLeg, y: StoredAccaLeg) => preference(y) - preference(x) || y.p - x.p;

const DUBLIN_DATE = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Dublin", year: "numeric", month: "2-digit", day: "2-digit" });
const settleDateOf = (legs: StoredAccaLeg[]) => DUBLIN_DATE.format(new Date(legs.map((l) => l.kickOff).sort().at(-1)!));
const product = (ls: StoredAccaLeg[]) => ls.reduce((s, l) => s * l.p, 1);
const byTime = (ls: StoredAccaLeg[]) => [...ls].sort((x, y) => x.kickOff.localeCompare(y.kickOff));

// Every game's best 80%+ leg, from the saved picks.
export function candidateLegs(days: StoredDay[], now: Date, keep: (code: string, g: StoredGame) => boolean = () => true): StoredAccaLeg[] {
  const out: StoredAccaLeg[] = [];
  for (const day of days) {
    for (const g of day.games) {
      if (new Date(g.kickOff) <= now || !keep(day.code, g)) continue;
      const best = g.strong
        .map((s) => ({ label: s.label, p: s.p, spec: s.spec } as StoredAccaLeg))
        .sort((x, y) => preference(y) - preference(x) || y.p - x.p)[0];
      if (!best) continue;
      out.push({ ...best, code: day.code, homeId: g.homeId, awayId: g.awayId, home: g.home, away: g.away, kickOff: g.kickOff, postedAt: day.postedAt });
    }
  }
  return out;
}

function finish(kind: AccaKind, legs: StoredAccaLeg[], date: string, now: Date, withSafer: boolean): StoredAcca {
  const p = product(legs);
  const safest = [...legs].sort((x, y) => y.p - x.p).slice(0, 4);
  const safer = withSafer && p < LONG_SHOT && legs.length > 4 ? { legs: byTime(safest), p: product(safest) } : null;
  return { kind, date, settleDate: settleDateOf(legs), postedAt: now.toISOString(), legs: byTime(legs), p, safer };
}

export function buildAcca(kind: AccaKind, candidates: StoredAccaLeg[], date: string, now: Date): StoredAcca | null {
  if (candidates.length < MIN_LEGS) return null;
  return finish(kind, [...candidates].sort(rank).slice(0, MAX_LEGS), date, now, true);
}

// 🌍 Around the leagues: the single strongest leg from each league.
export function buildAroundTheLeagues(candidates: StoredAccaLeg[], date: string, now: Date): StoredAcca | null {
  const best = new Map<string, StoredAccaLeg>();
  for (const c of [...candidates].sort(rank)) if (!best.has(c.code)) best.set(c.code, c);
  if (best.size < MIN_LEGS) return null;
  return finish("around", [...best.values()], date, now, false);
}

// ---------------------------------------------------------------------------
// Posting
// ---------------------------------------------------------------------------
const DAY = new Intl.DateTimeFormat("en-IE", { weekday: "long", day: "numeric", month: "long", timeZone: "Europe/Dublin" });
const SHORT = new Intl.DateTimeFormat("en-IE", { weekday: "short", day: "numeric", timeZone: "Europe/Dublin" });
const unix = (iso: string) => Math.floor(new Date(iso).getTime() / 1000);

export const ACCA_NAMES: Record<AccaKind, string> = {
  daily: "🎟️ Hawk's Daily Acca",
  weekend: "🗓️ Hawk's Weekend Acca",
  around: "🌍 Around the Leagues",
  clweek: "🇪🇺 Champions League Matchweek Acca",
  clnight: "🌙 Tonight's Champions League Acca",
};

export function accaTitle(kind: AccaKind, acca: StoredAcca | null, now: Date) {
  if ((kind === "weekend" || kind === "clweek" || kind === "around") && acca) {
    const first = acca.legs[0].kickOff, last = acca.legs.at(-1)!.kickOff;
    return `${ACCA_NAMES[kind]} – ${SHORT.format(new Date(first))} to ${DAY.format(new Date(last))}`;
  }
  if (kind === "weekend" || kind === "around") return `${ACCA_NAMES[kind]} – this weekend`;
  if (kind === "clweek") return `${ACCA_NAMES[kind]} – this week`;
  return `${ACCA_NAMES[kind]} – ${DAY.format(now)}`;
}

export function accaEmbed(kind: AccaKind, acca: StoredAcca | null, now: Date, emptyText?: string) {
  const title = accaTitle(kind, acca, now);
  if (!acca) {
    return {
      title,
      description: emptyText ?? `No acca this time – Hawk needs at least ${MIN_LEGS} legs it rates at **80% or more**.\n\nNo acca is better than a weak one. 🦅`,
      color: COLOUR,
      footer: { text: "Powered by Hawk 🦅" },
    };
  }
  const multiDay = kind === "weekend" || kind === "clweek" || kind === "around";
  // Multi-day accas show the day too: "Sat 7 · 12:30" (the time is in each viewer's time zone)
  const when = (iso: string) => `${multiDay ? `${SHORT.format(new Date(iso))} · ` : ""}<t:${unix(iso)}:t>`;
  const line = (l: StoredAccaLeg, i: number) =>
    `**${i + 1}.** ${LEAGUES[l.code]?.emoji ?? "⚽"} ${l.home} v ${l.away} · ${when(l.kickOff)}\n　**${l.label}** – ${pct(l.p)}`;
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
  const rule = kind === "around" ? "The strongest pick from each league" : "One leg per game, 80%+ each";
  return {
    title,
    description: parts.join("\n"),
    color: COLOUR,
    footer: { text: `${rule} · Graded in #results after the last game · Powered by Hawk 🦅` },
  };
}

// 🔍 Why? for acca legs – each option points at the league run the leg came from.
export function accaWhyMenu(kind: AccaKind, acca: StoredAcca | null) {
  if (!acca) return [];
  return [{
    type: 1,
    components: [{
      type: 3,
      custom_id: `why:ac:${kind}:${acca.date}`,
      placeholder: "🔍 Why? Pick a leg to see Hawk's reasoning",
      options: acca.legs.map((l) => ({
        label: `${l.home} v ${l.away}`.slice(0, 100),
        value: `${l.code}:${unix(l.postedAt)}:${l.homeId}-${l.awayId}`,
        description: `${l.label} – ${pct(l.p)}`.slice(0, 100),
      })),
    }],
  }];
}
