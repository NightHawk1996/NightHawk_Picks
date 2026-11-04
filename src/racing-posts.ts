// Daily racing posts, built from what the collector saved:
//   #racecards       each morning – every GB & Irish race with its runners (yesterday's cards cleared)
//   #racing-results  each evening – first three home in every race, plus jockey & trainer form
//                    over the last 30 days (kept, like #results)
// No API calls here – everything comes from KV, so these never touch the Racing API's limits.

import { discord, getChannels, cleanChannel, dublinDate, log, type DiscordEnv } from "./discord";
import { loadRacecards, loadRaceResults } from "./racing";

export interface RacingPostEnv extends DiscordEnv { HAWK?: KVNamespace }

const COLOUR = 0xf2a900;
const FOOTER = { text: "Powered by Hawk 🦅" };
const MAX_MESSAGE = 5600; // Discord allows 6000 characters across a message's embeds
const TALLY_DAYS = 30;
const KEEP_SECONDS = 400 * 86400;

export const niceDate = (date: string) => new Date(`${date}T12:00:00Z`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });

// 16.5 furlongs → "2m½f"; 5 → "5f"
export function distance(f: unknown): string {
  const raw = String(f ?? "").trim();
  if (/m|[½¼¾]/.test(raw)) return raw; // already "2m4½f"
  const n = parseFloat(raw);
  if (!n) return "";
  const miles = Math.floor(n / 8), fur = n - miles * 8;
  const furText = fur ? `${Math.floor(fur) || ""}${fur % 1 >= 0.5 ? "½" : ""}f` : "";
  return `${miles ? `${miles}m` : ""}${furText}` || `${n}f`;
}
const stLb = (lbs: unknown) => { const n = Number(lbs); return n ? `${Math.floor(n / 14)}-${n % 14}` : ""; };
const offKey = (r: any) => String(r.off_dt ?? r.off_time ?? r.off ?? "");

// Races grouped by meeting, meetings in order of their first race
export function byMeeting(races: any[]): [string, any[]][] {
  const groups = new Map<string, any[]>();
  for (const r of [...races].sort((a, b) => offKey(a).localeCompare(offKey(b)))) {
    const c = r.course ?? "Unknown";
    groups.set(c, [...(groups.get(c) ?? []), r]);
  }
  return [...groups];
}

// Packs embeds into as few messages as Discord allows (10 embeds, ~6000 characters each)
function pack(embeds: any[], header: string): { content: string; embeds: any[] }[] {
  const size = (e: any) => (e.title?.length ?? 0) + (e.description?.length ?? 0) + (e.footer?.text?.length ?? 0);
  const out: { content: string; embeds: any[] }[] = [];
  let cur: any[] = [], total = 0;
  for (const e of embeds) {
    if (cur.length && (cur.length === 10 || total + size(e) > MAX_MESSAGE)) { out.push({ content: header, embeds: cur }); cur = []; total = 0; }
    cur.push(e); total += size(e);
  }
  if (cur.length) out.push({ content: header, embeds: cur });
  return out;
}

// ---------------------------------------------------------------------------
// Racecards
// ---------------------------------------------------------------------------
export function runnerLine(r: any): string {
  const bits = [
    r.age ? `${r.age}yo` : "",
    stLb(r.lbs),
    r.ofr && r.ofr !== "-" ? `OR ${r.ofr}` : "",
    r.last_run ? `${r.last_run}d` : "",
  ].filter(Boolean).join(" · ");
  const draw = r.draw ? ` (${r.draw})` : "";
  const gear = r.headgear ? ` _${r.headgear}_` : "";
  const people = [r.jockey, r.trainer].filter(Boolean).join(" / ");
  return `\`${String(r.number ?? "–").padStart(2)}\` **${r.horse}**${draw}${gear} · ${bits}${people ? ` · ${people}` : ""}`;
}

export function raceCardEmbed(race: any) {
  const runners = [...(race.runners ?? [])].sort((a, b) => Number(a.number ?? 99) - Number(b.number ?? 99));
  const info = [distance(race.distance_f ?? race.dist_f), race.race_class, race.pattern, race.type, race.age_band, race.rating_band ? `rated ${race.rating_band}` : "", `${runners.length} runners`, race.prize].filter(Boolean).join(" · ");
  let description = [`_${info}_`, ...runners.map(runnerLine)].join("\n");
  if (description.length > 4000) description = description.slice(0, 3990).replace(/\n[^\n]*$/, "") + "\n…";
  return { title: `${race.off_time ?? race.off ?? ""}  ${race.race_name ?? "Race"}`.slice(0, 250), description, color: COLOUR };
}

export function racecardMessages(races: any[], date: string) {
  const messages: { content: string; embeds: any[] }[] = [];
  for (const [course, rs] of byMeeting(races)) {
    const going = rs.find((r) => r.going)?.going, surface = rs.find((r) => r.surface)?.surface;
    const header = `🏇 **${course}** · ${niceDate(date)}${going ? ` · Going: ${going}` : ""}${surface ? ` · ${surface}` : ""} · ${rs.length} races`;
    const embeds = rs.map(raceCardEmbed);
    embeds[embeds.length - 1].footer = FOOTER;
    messages.push(...pack(embeds, header));
  }
  return messages;
}

export async function postRacecards(env: RacingPostEnv, date = dublinDate(new Date())): Promise<string> {
  const ch = await getChannels(env);
  const id = ch.idFor("racecards");
  if (!id) throw new Error("No #racecards channel");
  const cards = await loadRacecards(env.HAWK, date);
  await cleanChannel(env, id, ch.botId, () => true); // yesterday's cards
  if (!cards?.races.length) {
    await discord(env, "POST", `/channels/${id}/messages`, { content: `🏇 No GB or Irish racecards saved for ${niceDate(date)}.` });
    return `🏇 #racecards: nothing saved for ${niceDate(date)}`;
  }
  const messages = racecardMessages(cards.races, date);
  for (const m of messages) await discord(env, "POST", `/channels/${id}/messages`, m);
  const line = `🏇 #racecards posted – ${cards.races.length} races at ${byMeeting(cards.races).length} meetings (${messages.length} posts)`;
  await log(env, ch, line);
  return line;
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------
const MEDALS = ["🥇", "🥈", "🥉"];
const posNum = (p: unknown) => { const n = Number(p); return Number.isFinite(n) && n > 0 ? n : 999; };

export function resultLine(race: any): string {
  const runners = race.runners ?? [];
  const placed = [...runners].filter((r) => posNum(r.position) <= 3).sort((a, b) => posNum(a.position) - posNum(b.position));
  const top = placed.map((r) => `${MEDALS[posNum(r.position) - 1] ?? ""} **${r.horse}**${posNum(r.position) === 1 ? ` (${[r.jockey, r.trainer].filter(Boolean).join(" / ")})` : ""}`).join("  ");
  const info = [distance(race.dist_f ?? race.distance_f), race.class ?? race.race_class, `${runners.length} ran`].filter(Boolean).join(" · ");
  return `**${race.off ?? race.off_time ?? ""}** ${race.race_name ?? ""} _(${info})_\n${top || "_no finishers recorded_"}`;
}

// Per-day jockey & trainer rides and wins, saved small so the 30-day table is cheap to build
export type DaySummary = { jockeys: Record<string, [number, number]>; trainers: Record<string, [number, number]> };
export function summariseDay(races: any[]): DaySummary {
  const s: DaySummary = { jockeys: {}, trainers: {} };
  for (const race of races) for (const r of race.runners ?? []) {
    const won = posNum(r.position) === 1 ? 1 : 0;
    // "Paddy Brennan (3)" – the claim allowance changes, the jockey doesn't
    for (const [k, raw] of [["jockeys", r.jockey], ["trainers", r.trainer]] as const) {
      const name = String(raw ?? "").replace(/\s*\(\d+\)$/, "").trim();
      if (!name) continue;
      const e = (s[k][name] ??= [0, 0]);
      e[0]++; e[1] += won;
    }
  }
  return s;
}
export function tallyLines(days: DaySummary[], key: "jockeys" | "trainers", minRides: number): string[] {
  const t = new Map<string, [number, number]>();
  for (const d of days) for (const [name, [rides, wins]] of Object.entries(d[key])) {
    const e = t.get(name) ?? [0, 0];
    t.set(name, [e[0] + rides, e[1] + wins]);
  }
  return [...t].filter(([, [rides, wins]]) => wins > 0 && rides >= minRides)
    .sort((a, b) => b[1][1] - a[1][1] || b[1][1] / b[1][0] - a[1][1] / a[1][0])
    .slice(0, 5)
    .map(([name, [rides, wins]], i) => `${i + 1}. **${name}** – ${wins} from ${rides} (${Math.round((wins / rides) * 100)}%)`);
}

async function tallyEmbed(kv: KVNamespace, date: string) {
  const dates = Array.from({ length: TALLY_DAYS }, (_, i) => dublinDate(new Date(new Date(`${date}T12:00:00Z`).getTime() - i * 864e5)));
  const days = (await Promise.all(dates.map((d) => kv.get<DaySummary>(`racingday:${d}`, "json")))).filter((d): d is DaySummary => !!d);
  const span = days.length >= TALLY_DAYS ? `last ${TALLY_DAYS} days` : `${days.length} day${days.length === 1 ? "" : "s"} so far – builds to ${TALLY_DAYS}`;
  const min = days.length >= 7 ? 10 : 1;
  const jockeys = tallyLines(days, "jockeys", min), trainers = tallyLines(days, "trainers", min);
  return {
    title: `📈 Jockey & trainer form – ${span}`,
    description: [`**Jockeys**`, ...(jockeys.length ? jockeys : ["_no winners yet_"]), "", `**Trainers**`, ...(trainers.length ? trainers : ["_no winners yet_"]), "", `_GB & Irish racing · wins from rides${min > 1 ? `, at least ${min} rides` : ""}_`].join("\n"),
    color: COLOUR,
    footer: FOOTER,
  };
}

export function resultsMessages(races: any[], date: string, tally?: any) {
  const embeds: any[] = byMeeting(races).map(([course, rs]) => ({
    title: `🏁 ${course}`,
    description: rs.map(resultLine).join("\n\n").slice(0, 4000),
    color: COLOUR,
  }));
  if (tally) embeds.push(tally);
  return pack(embeds, `🏁 **Racing results · ${niceDate(date)}**`);
}

export async function postRaceResults(env: RacingPostEnv, date = dublinDate(new Date())): Promise<string> {
  if (!env.HAWK) throw new Error("KV storage (HAWK) isn't set up");
  const ch = await getChannels(env);
  const id = ch.idFor("racing-results");
  if (!id) throw new Error("No #racing-results channel");
  const results = await loadRaceResults(env.HAWK, date);
  const tag = `Racing results · ${niceDate(date)}`;
  // Re-running for the same day replaces that day's posts; earlier days are kept
  await cleanChannel(env, id, ch.botId, (m) => String(m.content ?? "").includes(tag));
  if (!results?.races.length) return `🏁 #racing-results: no results saved for ${niceDate(date)}`;
  await env.HAWK.put(`racingday:${date}`, JSON.stringify(summariseDay(results.races)), { expirationTtl: KEEP_SECONDS });
  const messages = resultsMessages(results.races, date, await tallyEmbed(env.HAWK, date));
  for (const m of messages) await discord(env, "POST", `/channels/${id}/messages`, m);
  const line = `🏁 #racing-results posted – ${results.races.length} races (${messages.length} posts)`;
  await log(env, ch, line);
  return line;
}
