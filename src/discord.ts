// Small helpers for posting to Discord as Hawk, plus the daily clean-up.

export interface DiscordEnv {
  DISCORD_TOKEN: string;
  GUILD_ID: string;
}

export async function discord(env: DiscordEnv, method: string, path: string, body?: unknown): Promise<any> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(`https://discord.com/api/v10${path}`, {
      method,
      headers: {
        Authorization: `Bot ${env.DISCORD_TOKEN}`,
        "Content-Type": "application/json",
        "User-Agent": "DiscordBot (nighthawk-picks, 1.0)",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 429) {
      const wait = ((await res.json().catch(() => ({}))) as any).retry_after ?? 1;
      await new Promise((r) => setTimeout(r, Math.ceil(wait * 1000) + 100));
      continue;
    }
    if (!res.ok) throw new Error(`Discord ${method} ${path.split("?")[0]} → ${res.status}`);
    return res.status === 204 ? null : res.json();
  }
  throw new Error(`Discord ${method} ${path.split("?")[0]} → still rate limited`);
}

// Today's date in Ireland, e.g. "2026-11-07" – used for storage keys and clean-up.
const DATE_KEY = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Dublin", year: "numeric", month: "2-digit", day: "2-digit" });
export const dublinDate = (d: Date) => DATE_KEY.format(d);

export interface Channels { idFor: (name: string) => string | undefined; botId: string }

export async function getChannels(env: DiscordEnv): Promise<Channels> {
  const [channels, me] = await Promise.all([
    discord(env, "GET", `/guilds/${env.GUILD_ID}/channels`) as Promise<any[]>,
    discord(env, "GET", "/users/@me"),
  ]);
  return { idFor: (name) => channels.find((c) => c.type === 0 && c.name === name)?.id, botId: me.id };
}

// Deletes Hawk's own posts in a channel. `keep` decides which to leave alone.
// Hawk can always delete its own messages, so no extra permissions are needed.
export async function cleanChannel(env: DiscordEnv, channelId: string, botId: string, shouldDelete: (msg: any) => boolean): Promise<number> {
  const recent: any[] = await discord(env, "GET", `/channels/${channelId}/messages?limit=100`);
  const mine = recent.filter((m) => m.author?.id === botId && shouldDelete(m));
  for (const m of mine) await discord(env, "DELETE", `/channels/${channelId}/messages/${m.id}`).catch(() => {});
  return mine.length;
}

export async function log(env: DiscordEnv, ch: Channels, text: string) {
  const id = ch.idFor("bot-log");
  if (id) await discord(env, "POST", `/channels/${id}/messages`, { content: text }).catch(() => {});
}
