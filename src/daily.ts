// The 9am daily posts. One job per minute, so each run stays inside Cloudflare's free
// processing allowance and the football data rate limit:
//   9:00–9:06  one league each – fixtures, bet builders, reasoning summary, picks saved
//   9:08       Hawk's Acca, built from the picks saved by the league runs
//   9:10       #results – yesterday's picks graded

import { leagueDay, LEAGUES, COLOUR } from "./football";
import { whyMenu, summaryEmbed } from "./reasoning";
import { discord, getChannels, cleanChannel, dublinDate, log, type DiscordEnv } from "./discord";
import { toStoredGames, savePicks, loadPicks, saveAcca } from "./store";
import { buildAcca, accaEmbed, accaWhyMenu } from "./acca";

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
const RESULTS_MINUTE = 10;

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
  if (minute === RESULTS_MINUTE) return "RESULTS";
  return DAILY_ORDER[minute] ?? null;
}

const startedToday = (msg: any, today: string) => dublinDate(new Date(msg.timestamp)) === today;

// One league: clear yesterday's posts, post today's fixtures, builders and reasoning,
// save the picks, and leave a one-line report in #bot-log.
export async function runLeaguePost(env: DailyEnv, code: string, now = new Date()): Promise<string> {
  const l = LEAGUES[code];
  const channelName = LEAGUE_CHANNELS[code];
  const ch = await getChannels(env);
  const today = dublinDate(now);
  let line: string;

  try {
    const channelId = ch.idFor(channelName);
    if (!channelId) throw new Error("channel not found");
    const builderId = env.BET_BUILDERS_CHANNEL_ID || ch.idFor("bet-builders");
    const day = await leagueDay(code, env.FOOTBALL_DATA_TOKEN, now, 24, builderId);

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

// The acca: built from today's saved picks, posted to #hawk-acca, and saved for #results.
export async function runAccaPost(env: DailyEnv, now = new Date()): Promise<string> {
  const ch = await getChannels(env);
  let line: string;
  try {
    if (!env.HAWK) throw new Error("storage not set up");
    const channelId = ch.idFor("hawk-acca");
    if (!channelId) throw new Error("#hawk-acca not found");
    const today = dublinDate(now);
    const days = await loadPicks(env.HAWK, today);
    const acca = buildAcca(days, today, now);

    await cleanChannel(env, channelId, ch.botId, () => true);
    await discord(env, "POST", `/channels/${channelId}/messages`, { embeds: [accaEmbed(acca, now)], components: accaWhyMenu(acca) });
    if (acca) await saveAcca(env.HAWK, acca);
    line = acca ? `✅ #hawk-acca – ${acca.legs.length} legs, ${Math.round(acca.p * 100)}% together` : "💤 #hawk-acca – not enough strong legs today";
  } catch (err: any) {
    line = `⚠️ #hawk-acca – failed: ${err.message}`;
  }
  await log(env, ch, `🎟️ ${line}`);
  return line;
}
