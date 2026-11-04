// The 9am daily post: today's fixtures and predictions into each league's channel.
// One league per minute (9:00 Premier League, 9:01 Championship, …) so each run stays
// inside Cloudflare's free processing allowance and the football data rate limit.

import { leagueDay } from "./football";
import { whyMenu, summaryEmbed } from "./reasoning";

export interface DailyEnv {
  DISCORD_TOKEN: string;
  GUILD_ID: string;
  FOOTBALL_DATA_TOKEN: string;
  BET_BUILDERS_CHANNEL_ID?: string;
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

async function discord(env: DailyEnv, method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(`https://discord.com/api/v10${path}`, {
    method,
    headers: {
      Authorization: `Bot ${env.DISCORD_TOKEN}`,
      "Content-Type": "application/json",
      "User-Agent": "DiscordBot (nighthawk-picks, 1.0)",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`Discord ${method} ${path} → ${res.status}`);
  return res.status === 204 ? null : res.json();
}

const HOUR = new Intl.DateTimeFormat("en-IE", { hour: "numeric", hour12: false, timeZone: "Europe/Dublin" });

// Cron fires at 08:00–08:06 and 09:00–09:06 UTC; only the hour that is 9am in Dublin does
// the work, so the post stays at 9am Irish time through the clock changes.
export function isNineInDublin(when: Date): boolean {
  return Number(HOUR.format(when)) === 9;
}

// Which league this cron run is for (minute 0 = first league), or null.
export function leagueForRun(when: Date): string | null {
  if (!isNineInDublin(when)) return null;
  return DAILY_ORDER[when.getUTCMinutes()] ?? null;
}

// Posts one league's fixtures to its channel, its bet builders to #bet-builders,
// and leaves a one-line report in #bot-log.
export async function runLeaguePost(env: DailyEnv, code: string, now = new Date()): Promise<string> {
  const channelName = LEAGUE_CHANNELS[code];
  const channels: any[] = await discord(env, "GET", `/guilds/${env.GUILD_ID}/channels`);
  const idFor = (name: string) => channels.find((c) => c.type === 0 && c.name === name)?.id;

  let line: string;
  try {
    const channelId = idFor(channelName);
    if (!channelId) throw new Error("channel not found");
    const builderId = env.BET_BUILDERS_CHANNEL_ID || idFor("bet-builders");
    const day = await leagueDay(code, env.FOOTBALL_DATA_TOKEN, now, 24, builderId);
    if (!day.fixtures) {
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
      } else if (day.builders) {
        line += " · ⚠️ #bet-builders not found";
      }
      const reasoningId = idFor("hawk-reasoning");
      const summary = summaryEmbed(code, day.predictions, day.ratings);
      if (summary && reasoningId) {
        await discord(env, "POST", `/channels/${reasoningId}/messages`, { embeds: [summary] });
        line += " · 🔍 summary";
      } else if (summary) {
        line += " · ⚠️ #hawk-reasoning not found";
      }
    }
  } catch (err: any) {
    line = `⚠️ #${channelName} – failed: ${err.message}`;
  }

  const logId = idFor("bot-log");
  if (logId) await discord(env, "POST", `/channels/${logId}/messages`, { content: `☀️ ${line}` }).catch(() => {});
  return line;
}
