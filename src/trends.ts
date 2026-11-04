// /trends – the profile of recent winners of each Cheltenham Festival race and the Grand
// National: favourites' record, prices, ages, trainers, jockeys and weights.
// Data: past winners from Wikipedia (CC BY-SA), loaded by scripts/festival-trends.mjs.

import { COLOUR } from "./football";
import { toFraction } from "./model";

interface Winner { year: number; cancelled?: boolean; namesOnly?: boolean; winner?: string; age?: number | null; weight?: string | null; jockey?: string | null; trainer?: string | null; country?: string | null; sp?: string | null; fav?: string | null; field?: number | null }
interface Race { name: string; meeting: string; day: number; winners: Winner[] }
interface TrendsFile { generated: string; races: Race[] }

export async function loadTrends(kv?: KVNamespace): Promise<TrendsFile | null> {
  return kv ? kv.get<TrendsFile>("trends:festival", "json") : null;
}

// Autocomplete: races matching what's been typed so far (Discord allows 25)
export function raceChoices(t: TrendsFile | null, typed: string) {
  const q = typed.toLowerCase();
  return (t?.races ?? [])
    .filter((r) => !q || r.name.toLowerCase().includes(q))
    .slice(0, 25)
    .map((r) => ({ name: `${r.meeting === "Aintree" ? "🏇" : "🏆"} ${r.name}`.slice(0, 100), value: r.name }));
}

const decimal = (sp?: string | null) => {
  if (!sp) return null;
  if (/evens/i.test(sp)) return 2;
  const [a, b] = sp.split("/").map(Number);
  return a && b ? a / b + 1 : null;
};
// Counts names, treating "Henry De Bromhead" and "Henry de Bromhead" as the same person.
const top = (xs: (string | null | undefined)[], n: number) => {
  const counts = new Map<string, { name: string; c: number }>();
  for (const x of xs) {
    if (!x) continue;
    const key = x.toLowerCase().replace(/[^a-z0-9]/g, "");
    const e = counts.get(key) ?? { name: x, c: 0 };
    e.c++; counts.set(key, e);
  }
  return [...counts.values()].sort((a, b) => b.c - a.c).slice(0, n).map((e) => [e.name, e.c] as [string, number]);
};
const stones = (w: string) => { const [st, lb] = w.split("-").map(Number); return st * 14 + lb; };

export function trendsEmbed(t: TrendsFile, raceName: string, years = 10) {
  const race = t.races.find((r) => r.name === raceName) ?? t.races.find((r) => r.name.toLowerCase().includes(raceName.toLowerCase()));
  if (!race) throw new Error(`Couldn't find "${raceName}" – start typing and pick a race from the list.`);
  const runs = race.winners.filter((w) => !w.cancelled).sort((a, b) => b.year - a.year).slice(0, years);
  if (!runs.length) throw new Error(`No winners saved for ${race.name}.`);
  const n = runs.length;
  const lines: string[] = [];

  // Favourites and prices
  const favs = runs.filter((w) => w.fav).length;
  const prices = runs.map((w) => decimal(w.sp)).filter((x): x is number => x !== null);
  if (prices.length) {
    const short = prices.filter((d) => d <= 6).length, mid = prices.filter((d) => d > 6 && d <= 15).length, long = prices.filter((d) => d > 15).length;
    const biggest = runs.reduce((b, w) => ((decimal(w.sp) ?? 0) > (decimal(b.sp) ?? 0) ? w : b));
    lines.push(`⭐ **Favourites:** won **${favs} of ${n}**`);
    lines.push(`💷 **Prices:** 5/1 or shorter **${short}** · 11/2–14/1 **${mid}** · 16/1+ **${long}** · biggest: ${biggest.winner} at ${biggest.sp} (${biggest.year})`);
  }

  // Age
  const ages = top(runs.map((w) => (w.age ? `${w.age}` : null)), 6);
  if (ages.length) lines.push(`🎂 **Age:** ${ages.map(([a, c]) => `${a}yo ×${c}`).join(" · ")}`);

  // Weight (handicaps and the National)
  const weights = runs.map((w) => w.weight).filter((x): x is string => !!x);
  if (weights.length >= n / 2) {
    const heavy = weights.filter((w) => stones(w) >= 11 * 14).length;
    const sorted = [...weights].sort((a, b) => stones(a) - stones(b));
    lines.push(`⚖️ **Weight:** ${sorted[0]} to ${sorted.at(-1)} · carried 11-00 or more: **${heavy} of ${weights.length}**`);
  }

  // Trainers and jockeys
  const trainers = top(runs.map((w) => w.trainer), 3);
  if (trainers.length) lines.push(`🏠 **Trainers:** ${trainers.map(([t, c]) => `${t} ${c}`).join(" · ")}`);
  const countries = runs.map((w) => w.country).filter(Boolean);
  if (countries.length >= n * 0.8) lines.push(`🇮🇪 **Irish-trained:** ${countries.filter((c) => c === "IRE").length} of ${countries.length}`);
  const jockeys = top(runs.map((w) => w.jockey), 3);
  if (jockeys.length) lines.push(`🏇 **Jockeys:** ${jockeys.map(([j, c]) => `${j} ${c}`).join(" · ")}`);

  // Repeat winners
  const repeats = top(runs.map((w) => w.winner), 5).filter(([, c]) => c > 1);
  if (repeats.length) lines.push(`🔁 **Won it more than once:** ${repeats.map(([h, c]) => `${h} (${c})`).join(" · ")}`);

  // Hawk's profile – the common ground across most winners
  const profile: string[] = [];
  const ageNums = runs.map((w) => w.age).filter((x): x is number => !!x).sort((a, b) => a - b);
  if (ageNums.length >= 5) {
    const lo = ageNums[Math.floor(ageNums.length * 0.15)], hi = ageNums[Math.ceil(ageNums.length * 0.85) - 1];
    profile.push(lo === hi ? `aged ${lo}` : `aged ${lo}–${hi}`);
  }
  if (prices.length >= 5) {
    const sortedP = [...prices].sort((a, b) => a - b), cap = sortedP[Math.ceil(prices.length * 0.7) - 1];
    profile.push(`priced ${toFraction(cap)} or shorter (${prices.filter((d) => d <= cap).length} of ${prices.length})`);
  }
  if (trainers[0] && trainers[0][1] >= n * 0.3) profile.push(`${trainers[0][0]}-trained (${trainers[0][1]} of ${n})`);

  const namesOnly = runs.every((w) => !w.sp && !w.age && !w.trainer);
  if (namesOnly) lines.push("_Only the winners' names are on record for this race so far – prices, ages and trainers arrive with the February data top-up._");

  const recent = runs.slice(0, namesOnly ? 10 : 5).map((w) => `${w.year} **${w.winner}**${w.sp ? ` ${w.sp}` : ""}${w.fav ? (w.fav === "joint" ? " JF" : " F") : ""}${w.age ? ` · ${w.age}yo` : ""}${w.weight ? ` · ${w.weight}` : ""}${w.trainer ? ` · ${w.trainer}` : ""}`);

  return {
    title: `${race.meeting === "Aintree" ? "🏇" : "🏆"} ${race.name} – trends`,
    description: [
      `_${race.meeting}${race.meeting === "Cheltenham" ? ` · Day ${race.day}` : ""} · last ${n} runnings (${runs.at(-1)!.year}–${runs[0].year})_`,
      "",
      ...lines,
      ...(profile.length ? ["", `🧭 **Typical winner:** ${profile.join(", ")}`] : []),
      "",
      "**Recent winners**",
      ...recent,
    ].join("\n"),
    color: COLOUR,
    footer: { text: "Trends describe past winners – they're a guide, not a prediction · Winners: Wikipedia (CC BY-SA) · Powered by Hawk 🦅" },
  };
}
