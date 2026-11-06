// Straight wins only, posted at 9:07 after the league runs:
//   #hawk-nap      ⭐ the NAP – Hawk's most confident win of the day
//   #hawk-singles  🎯 up to 5 wins Hawk rates at 55%+, most likely first – on quiet days topped up
//                  with goals / BTTS / team-to-score picks at 55–75% (marked ➕)
//   #hawk-doubles  ✌️ the two most likely wins together
//   #hawk-trebles  🎲 the three most likely wins together
// Each shows Hawk's fair price and the bookies' prices, and is graded in #results.

import { discord, getChannels, cleanChannel, dublinDate, log, type DiscordEnv } from "./discord";
import { loadPicks, saveAcca, type StoredAcca, type StoredAccaLeg, type AccaKind } from "./store";
import { booksForLegs, legPrices, accaPrices, price, type BookPrices } from "./bookies";
import { accaWhyMenu, ACCA_NAMES } from "./acca";
import { LEAGUES, COLOUR } from "./football";
import { pct, fairOdds } from "./model";

export interface SinglesEnv extends DiscordEnv { HAWK?: KVNamespace }

export const MIN_WIN = 0.55;  // a win has to be Hawk's 👍 "fair" band or better
const MAX_SINGLES = 5;
const DAY = new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "Europe/Dublin" });
const unix = (iso: string) => Math.floor(Date.parse(iso) / 1000);

// Today's wins Hawk rates at 55%+, most likely first – one per game (a game's pick is its most likely result)
const legOf = (day: { code: string; postedAt: string }, g: any, l: { label: string; p: number; spec: any }): StoredAccaLeg =>
  ({ ...l, code: day.code, homeId: g.homeId, awayId: g.awayId, home: g.home, away: g.away, kickOff: g.kickOff, postedAt: day.postedAt, ...(g.oh ? { oh: g.oh, oa: g.oa } : {}) });

export function todaysWins(days: Awaited<ReturnType<typeof loadPicks>>, now: Date): StoredAccaLeg[] {
  const out: StoredAccaLeg[] = [];
  for (const day of days) for (const g of day.games) {
    const s = g.pick.spec;
    if (new Date(g.kickOff) <= now || s.t !== "res" || (s.v !== "H" && s.v !== "A") || g.pick.p < MIN_WIN) continue;
    out.push(legOf(day, g, g.pick));
  }
  return out.sort((a, b) => b.p - a.p);
}

// Quiet days: top up with goals, BTTS or team-to-score legs Hawk rates at 55–75% (prices roughly
// 1/3 to 4/5 – never the 1/8 "safe" legs), one per game, from games without a win already picked.
export function topUps(days: Awaited<ReturnType<typeof loadPicks>>, now: Date, used: Set<string>): StoredAccaLeg[] {
  const out: StoredAccaLeg[] = [];
  for (const day of days) for (const g of day.games) {
    if (new Date(g.kickOff) <= now || used.has(`${day.code}:${g.homeId}`) || !g.mid?.length) continue;
    out.push(legOf(day, g, g.mid[0]));
  }
  return out.sort((a, b) => b.p - a.p);
}
const isWin = (l: StoredAccaLeg) => l.spec.t === "res" && (l.spec.v === "H" || l.spec.v === "A");

function makeBet(kind: AccaKind, legs: StoredAccaLeg[], today: string): StoredAcca {
  const settle = legs.map((l) => dublinDate(new Date(l.kickOff))).sort().at(-1)!;
  return { kind, date: today, settleDate: settle, postedAt: new Date().toISOString(), legs, p: legs.reduce((x, l) => x * l.p, 1), safer: null };
}

const pricesFor = (leg: StoredAccaLeg, books?: BookPrices) => {
  const top = legPrices(leg.spec, books).slice(0, 3);
  return top.length ? ` · ${top.map((b) => `${b.book} **${price(b.price)}**`).join(" · ")}` : "";
};
const gameLine = (l: StoredAccaLeg) => `${LEAGUES[l.code]?.emoji ?? "⚽"} ${l.home} v ${l.away} · <t:${unix(l.kickOff)}:t>`;
const tag = (l: StoredAccaLeg) => (isWin(l) ? "" : " ➕");
const TOPUP_NOTE = "\n➕ = not enough wins at 55%+ today, so topped up with Hawk's best goals, BTTS or team-to-score picks (55–75%).";
const FOOT = "Bookie prices from this morning – they move, so check before you bet · Graded in #results · Powered by Hawk 🦅";

export function napEmbed(bet: StoredAcca | null, now: Date, books?: (BookPrices | undefined)[]) {
  const title = `${ACCA_NAMES.nap} – ${DAY.format(now)}`;
  if (!bet) return { title, description: `No NAP today – no games left today, or nothing Hawk rates at ${pct(MIN_WIN)} or more.\n\nNo NAP is better than a forced one. 🦅`, color: COLOUR, footer: { text: "Powered by Hawk 🦅" } };
  const l = bet.legs[0];
  return {
    title,
    description: [
      `## ${l.label}`,
      gameLine(l),
      "",
      `Hawk **${pct(l.p)}** · fair price **${fairOdds(l.p)}**${pricesFor(l, books?.[0])}`,
      "",
      isWin(l) ? "_Hawk's most confident win of the day – the single result it rates highest._"
        : `_➕ No win reached ${pct(MIN_WIN)} today, so the NAP is Hawk's strongest goals, BTTS or team-to-score pick instead._`,
    ].join("\n"),
    color: COLOUR,
    footer: { text: FOOT },
  };
}

export function singlesEmbed(bets: StoredAcca[], now: Date, books?: (BookPrices | undefined)[]) {
  const title = `${ACCA_NAMES.singles} – ${DAY.format(now)}`;
  if (!bets.length) return { title, description: `No singles today – no games left today, or nothing Hawk rates at ${pct(MIN_WIN)} or more.`, color: COLOUR, footer: { text: "Powered by Hawk 🦅" } };
  return {
    title,
    description: bets.map((b, i) => `**${i + 1}.** ${gameLine(b.legs[0])}\n　**${b.legs[0].label}**${tag(b.legs[0])} – ${pct(b.p)} · fair **${fairOdds(b.p)}**${pricesFor(b.legs[0], books?.[i])}`).join("\n")
      + `\n\n_Straight wins Hawk rates at ${pct(MIN_WIN)}+ first, most likely first – each one a separate bet._${bets.some((b) => !isWin(b.legs[0])) ? TOPUP_NOTE : ""}`,
    color: COLOUR,
    footer: { text: FOOT },
  };
}

export function multipleEmbed(kind: "double" | "treble", bet: StoredAcca | null, now: Date, books?: (BookPrices | undefined)[]) {
  const title = `${ACCA_NAMES[kind]} – ${DAY.format(now)}`;
  const need = kind === "double" ? 2 : 3;
  if (!bet) return { title, description: `No ${kind} today – Hawk needs ${need} games with a pick it rates at ${pct(MIN_WIN)} or more.`, color: COLOUR, footer: { text: "Powered by Hawk 🦅" } };
  const top = books ? accaPrices(bet.legs.map((l, i) => ({ spec: l.spec, books: books[i] }))).slice(0, 3) : [];
  return {
    title,
    description: [
      bet.legs.map((l, i) => `**${i + 1}.** ${gameLine(l)}\n　**${l.label}**${tag(l)} – ${pct(l.p)} · fair **${fairOdds(l.p)}**${pricesFor(l, books?.[i])}`).join("\n"),
      "",
      `**Together: ${pct(bet.p)}** – Hawk's fair price **${fairOdds(bet.p)}**${top.length ? ` · ${top.map((b) => `${b.book} **${price(b.price)}**`).join(" · ")}` : ""}`,
      `_The ${need} strongest picks of the day, wins first – ${need === 2 ? "both" : "all three"} have to land._${bet.legs.some((l) => !isWin(l)) ? TOPUP_NOTE : ""}`,
    ].join("\n"),
    color: COLOUR,
    footer: { text: FOOT },
  };
}

export async function runSinglesPost(env: SinglesEnv, now = new Date()): Promise<string> {
  const ch = await getChannels(env);
  const parts: string[] = [];
  try {
    if (!env.HAWK) throw new Error("storage not set up");
    const today = dublinDate(now);
    const days = await loadPicks(env.HAWK, today);
    const winsOnly = todaysWins(days, now);
    const used = new Set(winsOnly.map((w) => `${w.code}:${w.homeId}`));
    const wins = [...winsOnly, ...topUps(days, now, used)].slice(0, MAX_SINGLES); // wins first, then top-ups
    let books: (BookPrices | undefined)[] | undefined;
    try { books = await booksForLegs(env.HAWK, wins); } catch { books = undefined; }

    const nap = wins.length ? makeBet("nap", wins.slice(0, 1), today) : null;
    const singles = wins.map((w) => makeBet("singles", [w], today));
    const double = wins.length >= 2 ? makeBet("double", wins.slice(0, 2), today) : null;
    const treble = wins.length >= 3 ? makeBet("treble", wins.slice(0, 3), today) : null;

    const post = async (channel: string, embed: any, bet: StoredAcca | null, kind: AccaKind) => {
      const id = ch.idFor(channel);
      if (!id) { parts.push(`#${channel} missing`); return; }
      await cleanChannel(env, id, ch.botId, () => true);
      await discord(env, "POST", `/channels/${id}/messages`, { embeds: [embed], components: bet ? accaWhyMenu(kind, bet) : [] });
    };
    await post("hawk-nap", napEmbed(nap, now, books), nap, "nap");
    await post("hawk-singles", singlesEmbed(singles, now, books), wins.length ? makeBet("singles", wins, today) : null, "singles");
    await post("hawk-doubles", multipleEmbed("double", double, now, books), double, "double");
    await post("hawk-trebles", multipleEmbed("treble", treble, now, books), treble, "treble");

    // Saved for #results. Singles are saved together but graded one by one.
    if (nap) await saveAcca(env.HAWK, nap);
    if (wins.length) await saveAcca(env.HAWK, makeBet("singles", wins, today));
    if (double) await saveAcca(env.HAWK, double);
    if (treble) await saveAcca(env.HAWK, treble);
    parts.unshift(nap ? `NAP ${nap.legs[0].label} ${pct(nap.p)} · ${wins.length} singles (${winsOnly.length >= wins.length ? "all wins" : `${Math.min(winsOnly.length, wins.length)} wins + ${wins.length - Math.min(winsOnly.length, wins.length)} topped up`}) · double ${double ? pct(double.p) : "none"} · treble ${treble ? pct(treble.p) : "none"}` : "nothing at 55%+ today");
  } catch (err: any) {
    parts.unshift(`failed: ${err.message}`);
  }
  const line = `⭐ Singles & NAP – ${parts.join(" · ")}`;
  await log(env, ch, line);
  return line;
}
