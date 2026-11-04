// Daily racing collector – saves The Racing API's free racecards and results to KV, so Hawk
// builds up its own record of every GB & Irish race from today onwards.
//   07:40 UTC  today's racecards (final declarations, non-runners)
//   21:40 UTC  today's results
//   21:41 UTC  tomorrow's racecards
// One request per run, so the free plan's limit of 1 request a second is never close.
// Stored for 400 days: racecards:YYYY-MM-DD and raceresults:YYYY-MM-DD.

import { getChannels, dublinDate, log, type DiscordEnv } from "./discord";

export interface RacingEnv extends DiscordEnv {
  RACING_USER?: string;
  RACING_PASS?: string;
  HAWK?: KVNamespace;
}

const BASE = "https://api.theracingapi.com";
const KEEP_SECONDS = 400 * 86400;
const REGIONS = new Set(["GB", "IRE"]);

export type RacingTask = "CARDS_TODAY" | "RESULTS" | "CARDS_TOMORROW";

export function racingTaskForRun(when: Date): RacingTask | null {
  const h = when.getUTCHours(), m = when.getUTCMinutes();
  if (h === 7 && m === 40) return "CARDS_TODAY";
  if (h === 21 && m === 40) return "RESULTS";
  if (h === 21 && m === 41) return "CARDS_TOMORROW";
  return null;
}

async function racingGet(env: RacingEnv, path: string): Promise<any> {
  if (!env.RACING_USER || !env.RACING_PASS) throw new Error("Racing API login isn't set – run `npx wrangler secret put RACING_USER` and `RACING_PASS`");
  const res = await fetch(BASE + path, {
    headers: { Authorization: "Basic " + btoa(`${env.RACING_USER.trim()}:${env.RACING_PASS.trim()}`), "User-Agent": "NightHawkPicks/1.0" },
  });
  const text = await res.text();
  if (/plan required/i.test(text) || res.status === 402 || res.status === 403) throw new Error(`Racing API: ${path.split("?")[0]} isn't on the free plan`);
  if (res.status === 401) throw new Error(`Racing API login rejected (username is ${env.RACING_USER.trim().length} characters) – the API said: ${text.slice(0, 120).replace(/\s+/g, " ")}`);
  if (res.status === 429) throw new Error("Racing API: too many requests – will try again next run");
  if (!res.ok) throw new Error(`Racing API ${path.split("?")[0]} → ${res.status}`);
  return JSON.parse(text);
}

const firstArray = (j: any): any[] => (Array.isArray(j) ? j : (j && Object.values(j).find(Array.isArray)) as any[]) ?? [];
const inRegion = (r: any) => !r.region || REGIONS.has(String(r.region).toUpperCase());

// Groups races by their own date (falls back to the day asked for) and saves each day.
async function saveByDate(kv: KVNamespace, prefix: string, races: any[], fallbackDate: string) {
  const byDate = new Map<string, any[]>();
  for (const r of races) {
    const d = typeof r.date === "string" && /^\d{4}-\d{2}-\d{2}/.test(r.date) ? r.date.slice(0, 10) : fallbackDate;
    byDate.set(d, [...(byDate.get(d) ?? []), r]);
  }
  for (const [d, rs] of byDate) await kv.put(`${prefix}:${d}`, JSON.stringify({ saved: new Date().toISOString(), races: rs }), { expirationTtl: KEEP_SECONDS });
  return [...byDate.keys()];
}

const nice = (date: string) => new Date(`${date}T12:00:00Z`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
function meetings(races: any[]) {
  const counts = new Map<string, number>();
  for (const r of races) counts.set(r.course ?? "?", (counts.get(r.course ?? "?") ?? 0) + 1);
  return [...counts].map(([c, n]) => `${c} ${n}`).join(" · ");
}

export async function collectRacecards(env: RacingEnv, day: "today" | "tomorrow", now = new Date()): Promise<string> {
  if (!env.HAWK) throw new Error("KV storage (HAWK) isn't set up");
  const races = firstArray(await racingGet(env, `/v1/racecards/free?day=${day}`)).filter(inRegion);
  const date = dublinDate(day === "today" ? now : new Date(now.getTime() + 864e5));
  if (!races.length) return `🏇 Racecards ${nice(date)}: none published (no GB/Irish racing, or not out yet)`;
  const dates = await saveByDate(env.HAWK, "racecards", races, date);
  const runners = races.reduce((s, r) => s + (r.runners?.length ?? 0), 0);
  return `🏇 Racecards ${dates.map(nice).join(", ")} saved – ${races.length} races, ${runners} runners · ${meetings(races)}`;
}

export async function collectResults(env: RacingEnv, now = new Date()): Promise<string> {
  if (!env.HAWK) throw new Error("KV storage (HAWK) isn't set up");
  const races = firstArray(await racingGet(env, "/v1/results/today/free")).filter(inRegion);
  const date = dublinDate(now);
  if (!races.length) return `🏁 Results ${nice(date)}: none returned (no GB/Irish racing today, or not published yet)`;
  const dates = await saveByDate(env.HAWK, "raceresults", races, date);
  let line = `🏁 Results ${dates.map(nice).join(", ")} saved – ${races.length} races · ${meetings(races)}`;
  // First time only: list what a result contains, so the next features are built on real fields
  if (!(await env.HAWK.get("racing:fields-logged"))) {
    const runner = races[0].runners?.[0] ?? {};
    line += `\n📋 Result fields (one-off note): race – ${Object.keys(races[0]).filter((k) => k !== "runners").join(", ")}\nrunner – ${Object.keys(runner).join(", ")}`;
    await env.HAWK.put("racing:fields-logged", new Date().toISOString());
  }
  return line;
}

export async function runRacingTask(env: RacingEnv, task: RacingTask, now = new Date()): Promise<string> {
  const ch = await getChannels(env);
  let line: string;
  try {
    line = task === "RESULTS" ? await collectResults(env, now) : await collectRacecards(env, task === "CARDS_TODAY" ? "today" : "tomorrow", now);
  } catch (err: any) {
    line = `⚠️ Racing collector (${task.toLowerCase().replace("_", " ")}): ${err.message}`;
  }
  await log(env, ch, line.slice(0, 1990));
  return line;
}

// Manual run from /daily-post: today's cards, then today's results – spaced for the 1-a-second limit.
export async function runRacingNow(env: RacingEnv, now = new Date()): Promise<string> {
  const a = await runRacingTask(env, "CARDS_TODAY", now);
  await new Promise((r) => setTimeout(r, 1300));
  const b = await runRacingTask(env, "RESULTS", now);
  return `${a}\n${b}`.slice(0, 1990);
}

export async function loadRacecards(kv: KVNamespace | undefined, date: string) {
  return kv ? kv.get<{ saved: string; races: any[] }>(`racecards:${date}`, "json") : null;
}
export async function loadRaceResults(kv: KVNamespace | undefined, date: string) {
  return kv ? kv.get<{ saved: string; races: any[] }>(`raceresults:${date}`, "json") : null;
}
