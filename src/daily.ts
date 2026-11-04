// The 9am daily post: today's fixtures into each league's channel,
// plus a short report in #bot-log.

import { fixturesEmbed } from "./football";

export interface DailyEnv {
  DISCORD_TOKEN: string;
  GUILD_ID: string;
  FOOTBALL_DATA_TOKEN: string;
}

// Which competition posts into which channel.
export const LEAGUE_CHANNELS: Record<string, string> = {
  PL: "premier-league",
  ELC: "championship",
  PD: "la-liga",
  SA: "serie-a",
  BL1: "bundesliga",
  FL1: "ligue-1",
  CL: "champions-league",
};

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

// Cron runs at 08:00 and 09:00 UTC; only the one that lands on 9am in Dublin does the work,
// so the post stays at 9am Irish time through the clock changes.
export function isNineInDublin(when: Date): boolean {
  const hour = new Intl.DateTimeFormat("en-IE", { hour: "numeric", hour12: false, timeZone: "Europe/Dublin" }).format(when);
  return Number(hour) === 9;
}

export async function runDailyPost(env: DailyEnv, now = new Date()): Promise<string> {
  const channels: any[] = await discord(env, "GET", `/guilds/${env.GUILD_ID}/channels`);
  const idFor = (name: string) => channels.find((c) => c.type === 0 && c.name === name)?.id;

  const posted: string[] = [];
  const quiet: string[] = [];
  const failed: string[] = [];

  for (const [code, channelName] of Object.entries(LEAGUE_CHANNELS)) {
    const channelId = idFor(channelName);
    if (!channelId) {
      failed.push(`#${channelName} (channel not found)`);
      continue;
    }
    try {
      const embed = await fixturesEmbed(code, env.FOOTBALL_DATA_TOKEN, now, 24);
      if (!embed) {
        quiet.push(`#${channelName}`);
        continue;
      }
      await discord(env, "POST", `/channels/${channelId}/messages`, { embeds: [embed] });
      posted.push(`#${channelName}`);
    } catch (err: any) {
      failed.push(`#${channelName} (${err.message})`);
    }
  }

  const summary = [
    `☀️ **Daily football post** – ${now.toLocaleString("en-IE", { timeZone: "Europe/Dublin" })}`,
    `✅ Posted: ${posted.join(", ") || "none"}`,
    `💤 No games today: ${quiet.join(", ") || "none"}`,
    failed.length ? `⚠️ Failed: ${failed.join(", ")}` : "",
  ].filter(Boolean).join("\n");

  const logId = idFor("bot-log");
  if (logId) {
    await discord(env, "POST", `/channels/${logId}/messages`, { content: summary }).catch(() => {});
  }
  return summary;
}
