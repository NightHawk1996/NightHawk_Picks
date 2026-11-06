// Each bookie's own prices, so anyone can use the bookie they have.
//   • The Odds API (fetched at 9am already): ~15 UK & Irish bookies – match result and over/under 2.5
//   • OddsPapi via the GitHub Action (scripts/bookie-odds.mjs, ~7am): bet365 and Paddy Power for
//     every market Hawk uses – result, double chance, BTTS, goals, team goals, corners, cards
// Builder prices aren't available anywhere (bookies price those in-app), so builders show each
// leg's best single price and Hawk's fair price for the whole builder – never a made-up total.

import type { LegSpec } from "./model";
import { toFraction } from "./model";
import { loadOdds, nameMatch, type GameOdds } from "./odds";

type Pair = [number, number];
export interface MarketPrices {
  r?: [number, number, number];   // home / draw / away
  dc?: [number, number, number];  // 1X / 12 / X2
  btts?: Pair;                     // yes / no
  g?: Record<string, Pair>;        // goals over/under by line, e.g. "2.5": [over, under]
  t1?: Record<string, Pair>; t2?: Record<string, Pair>;     // home / away team goals
  c?: Record<string, Pair>; c1?: Record<string, Pair>; c2?: Record<string, Pair>; // corners
  k?: Record<string, Pair>; k1?: Record<string, Pair>; k2?: Record<string, Pair>; // cards
}
export type BookPrices = Record<string, MarketPrices>;
interface BookieGame { home: string; away: string; kickOff: string; books: BookPrices }

// The decimal price a bookie offers for one of Hawk's legs, if it offers it at all.
export function legPrice(spec: LegSpec, mp: MarketPrices | undefined): number | undefined {
  if (!mp) return undefined;
  const ou = (m: Record<string, Pair> | undefined, x: number, over: boolean) => m?.[String(x)]?.[over ? 0 : 1];
  switch (spec.t) {
    case "res":
      if (spec.v === "HD") return mp.dc?.[0];
      if (spec.v === "AD") return mp.dc?.[2];
      return mp.r?.["HDA".indexOf(spec.v)];
    case "tot": return ou(mp.g, spec.x, spec.op === ">");
    case "btts": return mp.btts?.[spec.yes ? 0 : 1];
    case "team": {
      const m = spec.side === "h" ? mp.t1 : mp.t2;
      return spec.zero ? ou(m, 0.5, false) : ou(m, (spec.min ?? 1) - 0.5, true);
    }
    case "corners": return ou(spec.side === "total" ? mp.c : spec.side === "h" ? mp.c1 : mp.c2, spec.x, spec.op === ">");
    case "cards":
      if (spec.x < 0) return undefined; // "both teams carded" – no matching bookie market
      return ou(spec.side === "total" ? mp.k : spec.side === "h" ? mp.k1 : mp.k2, spec.x, spec.op === ">");
  }
}

// Every bookie's price for a leg, biggest first
export function legPrices(spec: LegSpec, books: BookPrices | undefined): { book: string; price: number }[] {
  return Object.entries(books ?? {})
    .map(([book, mp]) => ({ book, price: legPrice(spec, mp) ?? 0 }))
    .filter((x) => x.price > 1)
    .sort((a, b) => b.price - a.price);
}

// A bookie's price as they'd show it: the standard fraction if it's one (5/6, 10/11, 6/4…),
// otherwise the closest simple fraction (1.95 → 19/20), never rounded to a different price.
export function price(d: number): string {
  const std = toFraction(d);
  const back = std === "Evens" ? 2 : (([a, b]) => a / b + 1)(std.split("/").map(Number));
  if (Math.abs(back - d) <= 0.006) return std;
  const x = d - 1;
  const maxDen = d < 1.5 ? 25 : 20; // 1.95 → 19/20 · 1.08 → 2/25
  for (let den = 1; den <= maxDen; den++) { // simplest exact fraction
    const n = Math.round(x * den);
    if (n > 0 && Math.abs(x - n / den) <= 0.0015 && (den <= 10 || n < den)) return n === den ? "Evens" : `${n}/${den}`;
  }
  for (const den of [25, 50, 100]) { // the way bookies quote odd prices: 0.86 → 43/50, 1.02 → 51/50
    const n = Math.round(x * den);
    if (n > 0 && Math.abs(x - n / den) <= 0.006 && x < 4) return `${n}/${den}`;
  }
  return `${Number(x.toFixed(2))}/1`; // e.g. an acca at 7.34 → "6.34/1", as bookies show it
}
// Up to 3 bookies' prices for a leg, biggest first: " · Paddy Power 1/5 · bet365 2/11 · Sky Bet 1/6"
export function bestLine(spec: LegSpec, books: BookPrices | undefined, max = 3): string {
  const top = legPrices(spec, books).slice(0, max);
  return top.length ? ` · ${top.map((b) => `${b.book} **${price(b.price)}**`).join(" · ")}` : "";
}

// An acca's price at each bookie that prices every leg, biggest first
export function accaPrices(legs: { spec: LegSpec; books?: BookPrices }[]): { book: string; price: number }[] {
  if (!legs.length) return [];
  const names = new Set(legs.flatMap((l) => Object.keys(l.books ?? {})));
  const out: { book: string; price: number }[] = [];
  for (const book of names) {
    let total = 1;
    for (const l of legs) {
      const p = legPrice(l.spec, l.books?.[book]);
      if (!p) { total = 0; break; }
      total *= p;
    }
    if (total > 1) out.push({ book, price: total });
  }
  return out.sort((a, b) => b.price - a.price);
}

// Adds the GitHub Action's bet365 / Paddy Power prices to The Odds API's per-bookie prices
async function loadBookieGames(kv: KVNamespace | undefined, code: string): Promise<BookieGame[]> {
  if (!kv) return [];
  return (await kv.get<{ games: BookieGame[] }>(`bookies:${code}`, "json"))?.games ?? [];
}
const sameGame = (a: { home: string; away: string; kickOff: string }, b: { home: string; away: string; kickOff: string }) =>
  Math.abs(Date.parse(a.kickOff) - Date.parse(b.kickOff)) <= 3 * 3600e3 && nameMatch(a.home, b.home) && nameMatch(a.away, b.away);

export async function attachBookies(kv: KVNamespace | undefined, code: string, games: GameOdds[]): Promise<GameOdds[]> {
  const extra = await loadBookieGames(kv, code);
  if (!extra.length) return games;
  return games.map((g) => {
    const b = extra.find((x) => sameGame(g, x));
    return b ? { ...g, byBook: { ...(g.byBook ?? {}), ...b.books } } : g;
  });
}

// The morning's prices for a league, with every bookie attached – for commands and accas
export async function loadPrices(kv: KVNamespace | undefined, code: string): Promise<GameOdds[]> {
  return attachBookies(kv, code, await loadOdds(kv, code));
}

// Each acca leg's bookie prices, found by league, kick-off and team names
// Uses the bookies' spelling saved with the pick ("Hamburger SV"), since Hawk's short names
// ("HSV", "PSG") often share no word with it.
export async function booksForLegs<T extends { code: string; home: string; away: string; kickOff: string; oh?: string; oa?: string }>(kv: KVNamespace | undefined, legs: T[]): Promise<(BookPrices | undefined)[]> {
  const byCode = new Map<string, GameOdds[]>();
  for (const code of new Set(legs.map((l) => l.code))) byCode.set(code, await loadPrices(kv, code));
  return legs.map((l) => {
    const want = { home: l.oh ?? l.home, away: l.oa ?? l.away, kickOff: l.kickOff };
    return byCode.get(l.code)?.find((g) => sameGame(g, want))?.byBook;
  });
}
