// The 9am daily posts. One job per minute, so each run stays inside Cloudflare's free
// processing allowance and the football data rate limit:
//   9:00–9:06  one league each – fixtures, bet builders, reasoning summary, picks saved
//   9:08       Daily acca (domestic leagues) in #hawk-daily-accas
//   9:09       Fridays: weekend acca + Around the Leagues in #hawk-weekend-accas
//              Champions League days: matchweek acca (first night) + tonight's acca in #hawk-cl-accas
//   9:10       #results – yesterday's picks and any accas that finished yesterday
//   9:11       Mondays: #model-check – is Hawk's 70% really 70%?

import { leagueDay, LEAGUES, COLOUR } from "./football";
import { whyMenu, summaryEmbed } from "./reasoning";
import { discord, getChannels, cleanChannel, dublinDate, log, type DiscordEnv } from "./discord";
import { toStoredGames, savePicks, loadPicks, saveAcca, saveAhead, loadAhead } from "./store";
import { buildAcca, buildAroundTheLeagues, candidateLegs, accaEmbed, accaWhyMenu } from "./acca";

export interface DailyEnv extends DiscordEnv {
  FOOTBALL_DATA_TOKEN: string;
  BET_BUILDERS_CHANNEL_ID?: string;
  HAWK?: KVNamespace;
}

// Which competition posts into which channel, in posting order.
export const LEAGUE_CHANNELS: Record<string, string> = {
  PL: "premier-league",
  ELC: "championship",
  PD: "la-liga",
  SA: "serie-a",
  BL1: "bundesliga",
  FL1: "ligue-1",
  CL: "champions-league",
};
export const DAILY_ORDER = Object.keys(LEAGUE_CHANNELS);
const ACCA_MINUTE = 8;
const SPECIAL_MINUTE = 9;
const RESULTS_MINUTE = 10;
const MODEL_CHECK_MINUTE = 11; // Mondays only

const WEEKDAY = new Intl.DateTimeFormat("en-GB", { weekday: "short", timeZone: "Europe/Dublin" });
export const weekday = (d: Date) => WEEKDAY.format(d); // "Mon", "Tue", …

// The end of the coming Sunday (Irish time, near enough), for the weekend window.
export function endOfWeekend(now: Date): Date {
  let d = new Date(now);
  while (weekday(d) !== "Sun") d = new Date(d.getTime() + 864e5);
  return new Date(`${dublinDate(d)}T23:30:00Z`);
}
// Monday of this week – identifies a Champions League matchweek.
export function weekKey(now: Date): string {
  let d = new Date(now);
  while (weekday(d) !== "Mon") d = new Date(d.getTime() - 864e5);
  return dublinDate(d);
}
const CL_WEEK_HOURS = 84; // first match night to the end of Thursday

const HOUR = new Intl.DateTimeFormat("en-IE", { hour: "numeric", hour12: false, timeZone: "Europe/Dublin" });

// Cron fires in both the 08:xx and 09:xx UTC hours; only the one that is 9am in Dublin
// does the work, so posts stay at 9am Irish time through the clock changes.
export function isNineInDublin(when: Date): boolean {
  return Number(HOUR.format(when)) === 9;
}

// What this cron run should do: a league code, "ACCA", or null.
export function jobForRun(when: Date): string | null {
  if (!isNineInDublin(when)) return null;
  const minute = when.getUTCMinutes();
  if (minute === ACCA_MINUTE) return "ACCA";
  if (minute === SPECIAL_MINUTE) return "SPECIAL";
  if (minute === RESULTS_MINUTE) return "RESULTS";
  if (minute === MODEL_CHECK_MINUTE) return weekday(when) === "Mon" ? "MODELCHECK" : null;
  return DAILY_ORDER[minute] ?? null;
}

const startedToday = (msg: any, today: string) => dublinDate(new Date(msg.timestamp)) === today;

// One league: clear yesterday's posts, post today's fixtures, builders and reasoning,
// save the picks, and leave a one-line report in #bot-log.
export async function runLeaguePost(env: DailyEnv, code: string, now = new Date(), manual = false): Promise<string> {
  const l = LEAGUES[code];
  const channelName = LEAGUE_CHANNELS[code];
  const ch = await getChannels(env);
  const today = dublinDate(now);
  let line: string;

  try {
    const channelId = ch.idFor(channelName);
    if (!channelId) throw new Error("channel not found");
    const builderId = env.BET_BUILDERS_CHANNEL_ID || ch.idFor("bet-builders");
    // Fridays: domestic leagues also predict their weekend games. Champions League: at the
    // start of a matchweek it predicts the whole week. Test runs always do, so you can try it.
    let aheadUntil: Date | undefined;
    if (code === "CL") {
      const weekPosted = env.HAWK ? await env.HAWK.get(`clweek:${weekKey(now)}`) : "x";
      if (manual || !weekPosted) aheadUntil = new Date(now.getTime() + CL_WEEK_HOURS * 3600e3);
    } else if (manual || weekday(now) === "Fri") {
      aheadUntil = endOfWeekend(now);
    }
    const day = await leagueDay(code, env.FOOTBALL_DATA_TOKEN, now, 24, builderId, aheadUntil);

    // Clean up: everything of Hawk's in the league channel goes, and in #bet-builders
    // anything from before today plus this league's earlier post today (if re-run).
    const cleared = await cleanChannel(env, channelId, ch.botId, () => true);
    if (builderId) {
      const mine = `🧩 ${l.emoji} ${l.name} –`;
      await cleanChannel(env, builderId, ch.botId, (m) => !startedToday(m, today) || (m.embeds?.[0]?.title ?? "").startsWith(mine));
    }

    if (!day.fixtures) {
      const next = day.nextKickOff
        ? `next up: **<t:${Math.floor(day.nextKickOff.getTime() / 1000)}:F>**`
        : "nothing in the next two weeks";
      await discord(env, "POST", `/channels/${channelId}/messages`, {
        embeds: [{ description: `💤 No ${l.name} games today – ${next}`, color: COLOUR }],
      });
      line = `💤 #${channelName} – no games today`;
    } else {
      await discord(env, "POST", `/channels/${channelId}/messages`, {
        embeds: [day.fixtures],
        components: whyMenu(code, now, day.predictions, "fx"),
      });
      line = `✅ #${channelName} – posted`;

      if (day.builders && builderId) {
        await discord(env, "POST", `/channels/${builderId}/messages`, {
          embeds: [day.builders],
          components: whyMenu(code, now, day.predictions.filter((x) => x.p.builder), "bb"),
        });
        line += ` · 🧩 ${day.builderCount} builder${day.builderCount === 1 ? "" : "s"}`;
      }

      const reasoningId = ch.idFor("hawk-reasoning");
      const summary = summaryEmbed(code, day.predictions, day.ratings);
      if (summary && reasoningId) {
        await discord(env, "POST", `/channels/${reasoningId}/messages`, { embeds: [summary] });
        line += " · 🔍 summary";
      }
    }

    // Save every pick so #results can grade it later.
    if (env.HAWK) {
      await savePicks(env.HAWK, { code, date: today, postedAt: now.toISOString(), games: toStoredGames(day.predictions) });
      if (day.predictions.length) line += ` · 💾 ${day.predictions.length} saved`;
      if (aheadUntil) {
        await saveAhead(env.HAWK, { code, date: today, postedAt: now.toISOString(), games: toStoredGames(day.ahead) });
        line += ` · 🔭 ${day.ahead.length} ahead`;
      }
    } else {
      line += " · ⚠️ storage not set up – picks not saved";
    }
    if (cleared) line += ` · 🧹 ${cleared} old`;
  } catch (err: any) {
    line = `⚠️ #${channelName} – failed: ${err.message}`;
  }

  await log(env, ch, `☀️ ${line}`);
  return line;
}

// The daily acca: today's domestic games only – Champions League legs live in #hawk-cl-accas.
export async function runAccaPost(env: DailyEnv, now = new Date()): Promise<string> {
  const ch = await getChannels(env);
  let line: string;
  try {
    if (!env.HAWK) throw new Error("storage not set up");
    const channelId = ch.idFor("hawk-daily-accas");
    if (!channelId) throw new Error("#hawk-daily-accas not found");
    const today = dublinDate(now);
    const legs = candidateLegs(await loadPicks(env.HAWK, today), now, (code) => code !== "CL");
    const acca = buildAcca("daily", legs, today, now);

    await cleanChannel(env, channelId, ch.botId, () => true);
    await discord(env, "POST", `/channels/${channelId}/messages`, { embeds: [accaEmbed("daily", acca, now)], components: accaWhyMenu("daily", acca) });
    if (acca) await saveAcca(env.HAWK, acca);
    line = acca ? `✅ #hawk-daily-accas – ${acca.legs.length} legs, ${Math.round(acca.p * 100)}% together` : "💤 #hawk-daily-accas – not enough strong legs today";
  } catch (err: any) {
    line = `⚠️ #hawk-daily-accas – failed: ${err.message}`;
  }
  await log(env, ch, `🎟️ ${line}`);
  return line;
}

const isWeekendGame = (iso: string, until: Date) => ["Fri", "Sat", "Sun"].includes(weekday(new Date(iso))) && new Date(iso) <= until;

// Friday: the weekend acca and Around the Leagues, from the games the league runs saved ahead.
export async function runWeekendPost(env: DailyEnv, now = new Date()): Promise<string> {
  const ch = await getChannels(env);
  let line: string;
  try {
    if (!env.HAWK) throw new Error("storage not set up");
    const channelId = ch.idFor("hawk-weekend-accas");
    if (!channelId) throw new Error("#hawk-weekend-accas not found");
    const today = dublinDate(now);
    const until = endOfWeekend(now);
    const days = (await loadAhead(env.HAWK, today)).filter((d) => d.code !== "CL");
    const legs = candidateLegs(days, now, (_c, g) => isWeekendGame(g.kickOff, until));
    const acca = buildAcca("weekend", legs, today, now);
    const around = buildAroundTheLeagues(legs, today, now);

    await cleanChannel(env, channelId, ch.botId, () => true);
    const empty = days.length ? undefined : "No weekend games saved yet – the league runs save them on Friday mornings.";
    await discord(env, "POST", `/channels/${channelId}/messages`, { embeds: [accaEmbed("weekend", acca, now, empty)], components: accaWhyMenu("weekend", acca) });
    await discord(env, "POST", `/channels/${channelId}/messages`, { embeds: [accaEmbed("around", around, now)], components: accaWhyMenu("around", around) });
    if (acca) await saveAcca(env.HAWK, acca);
    if (around) await saveAcca(env.HAWK, around);
    line = `✅ #hawk-weekend-accas – weekend ${acca ? `${acca.legs.length} legs, ${Math.round(acca.p * 100)}%` : "none"} · around the leagues ${around ? `${around.legs.length} legs, ${Math.round(around.p * 100)}%` : "none"}`;
  } catch (err: any) {
    line = `⚠️ #hawk-weekend-accas – failed: ${err.message}`;
  }
  await log(env, ch, `🗓️ ${line}`);
  return line;
}

// Champions League: on the first match night of a week, the matchweek acca; every match
// night, tonight's acca (replacing the previous night's).
export async function runChampionsLeaguePost(env: DailyEnv, now = new Date(), forceWeek = false): Promise<string> {
  const ch = await getChannels(env);
  let line: string;
  try {
    if (!env.HAWK) throw new Error("storage not set up");
    const channelId = ch.idFor("hawk-cl-accas");
    if (!channelId) throw new Error("#hawk-cl-accas not found");
    const today = dublinDate(now);
    const tonight = (await loadPicks(env.HAWK, today)).filter((d) => d.code === "CL");
    if (!tonight.some((d) => d.games.length)) return "💤 #hawk-cl-accas – no Champions League games today";

    const parts: string[] = [];
    const weekId = `clweek:${weekKey(now)}`;
    if (forceWeek || !(await env.HAWK.get(weekId))) {
      const ahead = await loadAhead(env.HAWK, today, "CL");
      const legs = candidateLegs(ahead, now);
      await cleanChannel(env, channelId, ch.botId, () => true); // new week – clear last week's
      // A matchweek acca only makes sense across two or more nights – otherwise it's just
      // tonight's acca twice.
      const nights = new Set(legs.map((l) => dublinDate(new Date(l.kickOff)))).size;
      if (nights >= 2) {
        const week = buildAcca("clweek", legs, today, now);
        await discord(env, "POST", `/channels/${channelId}/messages`, { embeds: [accaEmbed("clweek", week, now)], components: accaWhyMenu("clweek", week) });
        if (week) await saveAcca(env.HAWK, week);
        parts.push(`matchweek ${week ? `${week.legs.length} legs, ${Math.round(week.p * 100)}%` : "none"}`);
      } else {
        parts.push("matchweek skipped (only one night left this week)");
      }
      await env.HAWK.put(weekId, "posted", { expirationTtl: 60 * 60 * 24 * 10 });
    }

    const night = buildAcca("clnight", candidateLegs(tonight, now), today, now);
    await cleanChannel(env, channelId, ch.botId, (m) => (m.embeds?.[0]?.title ?? "").startsWith("🌙"));
    await discord(env, "POST", `/channels/${channelId}/messages`, { embeds: [accaEmbed("clnight", night, now)], components: accaWhyMenu("clnight", night) });
    if (night) await saveAcca(env.HAWK, night);
    parts.push(`tonight ${night ? `${night.legs.length} legs, ${Math.round(night.p * 100)}%` : "none"}`);
    line = `✅ #hawk-cl-accas – ${parts.join(" · ")}`;
  } catch (err: any) {
    line = `⚠️ #hawk-cl-accas – failed: ${err.message}`;
  }
  await log(env, ch, `🇪🇺 ${line}`);
  return line;
}

// 9:09 – whichever specials apply today.
export async function runSpecialPosts(env: DailyEnv, now = new Date()): Promise<string> {
  const lines: string[] = [];
  if (weekday(now) === "Fri") lines.push(await runWeekendPost(env, now));
  const cl = await runChampionsLeaguePost(env, now);
  if (!cl.startsWith("💤")) lines.push(cl);
  return lines.join("\n") || "Nothing special today";
}
