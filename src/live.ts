// #live-bets – one message per bet (NAP, singles, double, treble, accas) with a game today,
// edited every 10 minutes with live scores from ESPN:
//   ✅ landed · ❌ gone · 🟢 on course (would land if it ended now) · 🟠 needs a change · ⏳ to play
// Corners and cards legs aren't in these bets, so the score is all that's needed.
// The official result still comes from #results the next morning (90-minute score, voids etc).

import { discord, getChannels, cleanChannel, dublinDate, log, type DiscordEnv } from "./discord";
import { findEspnGame, ESPN_SLUG, type EspnGame } from "./espn";
import { todaysBets, type LiveBet } from "./livebets";
import { ACCA_NAMES } from "./acca";
import { LEAGUES, COLOUR } from "./football";
import { gradeLeg, pct, type LegSpec } from "./model";
import { price } from "./bookies";
import type { StoredAccaLeg } from "./store";

export interface LiveEnv extends DiscordEnv { HAWK?: KVNamespace }
type LegState = "won" | "lost" | "on" | "off" | "todo" | "unknown";
const ICON: Record<LegState, string> = { won: "✅", lost: "❌", on: "🟢", off: "🟠", todo: "⏳", unknown: "❔" };

// Can a leg already be settled mid-game? (over 1.5 with 2 goals in can't lose; BTTS no with both scored can't win…)
export function liveState(spec: LegSpec, h: number, a: number, state: EspnGame["state"]): LegState {
  if (state === "pre") return "todo";
  if (spec.t === "corners" || spec.t === "cards") return "unknown";
  const now = gradeLeg(spec, h, a);
  if (state === "post") return now ? "won" : "lost";
  if (spec.t === "tot") {
    if (spec.op === ">" && h + a > spec.x) return "won";
    if (spec.op === "<" && h + a > spec.x) return "lost";
  }
  if (spec.t === "btts" && h > 0 && a > 0) return spec.yes ? "won" : "lost";
  if (spec.t === "team" && !spec.zero && (spec.side === "h" ? h : a) >= (spec.min ?? 1)) return "won";
  if (spec.t === "team" && spec.zero && (spec.side === "h" ? h : a) > 0) return "lost";
  return now ? "on" : "off";
}

interface LegView { leg: StoredAccaLeg; game?: EspnGame; state: LegState }
const unix = (iso: string) => Math.floor(Date.parse(iso) / 1000);
const DAY = new Intl.DateTimeFormat("en-GB", { weekday: "short", timeZone: "Europe/Dublin" });

function legLine(v: LegView, today: string): string {
  const { leg, game } = v;
  const h = game?.teams.find((t) => t.side === "home")?.score ?? 0, a = game?.teams.find((t) => t.side === "away")?.score ?? 0;
  const otherDay = dublinDate(new Date(leg.kickOff)) !== today;
  const when = !game || game.state === "pre"
    ? `${otherDay ? `${DAY.format(new Date(leg.kickOff))} ` : ""}<t:${unix(leg.kickOff)}:t>`
    : game.state === "in" ? `**${h}-${a}** (${game.clock})` : `**${h}-${a}** FT`;
  return `${ICON[v.state]} ${LEAGUES[leg.code]?.emoji ?? "⚽"} ${leg.home} v ${leg.away} · ${when}\n　${leg.label} (${pct(leg.p)})`;
}

export function betEmbed(bet: LiveBet, views: LegView[], today: string) {
  const kind = bet.acca.kind ?? "daily";
  const name = ACCA_NAMES[kind];
  const count = (s: LegState) => views.filter((v) => v.state === s).length;
  let headline: string;
  if (kind === "singles") {
    headline = `${count("won")} landed · ${count("lost")} lost · ${count("on") + count("off")} in play · ${count("todo")} to play`;
  } else if (count("lost")) {
    headline = "❌ **Gone** – a leg has lost";
  } else if (views.every((v) => v.state === "won")) {
    headline = `✅ **Landed!**${bet.acca.price ? ` (${bet.acca.book} ${price(bet.acca.price)})` : ""}`;
  } else {
    const playing = views.filter((v) => v.state === "on" || v.state === "off");
    headline = `${count("won")} ✅ · ${playing.length} in play${count("off") ? ` (${count("off")} 🟠 need a change)` : ""} · ${count("todo")} to play`;
  }
  return {
    title: `${name} – live`,
    description: [headline, "", ...views.map((v) => legLine(v, today))].join("\n").slice(0, 4000),
    color: COLOUR,
    footer: { text: "Updates every 10 minutes · 🟢 on course · 🟠 needs a change · ⏳ to play · Official result in #results tomorrow · Powered by Hawk 🦅" },
  };
}

export async function runLiveTracker(env: LiveEnv, now = new Date()): Promise<string | null> {
  if (!env.HAWK) return null;
  const kv = env.HAWK;
  const today = dublinDate(now);
  const bets = await todaysBets(kv, now);
  if (!bets.length) return null;
  // Only bother once the day's first game is within the hour, and until its last has finished
  const legs = bets.flatMap((b) => b.acca.legs).filter((l) => dublinDate(new Date(l.kickOff)) === today);
  const first = Math.min(...legs.map((l) => Date.parse(l.kickOff))), last = Math.max(...legs.map((l) => Date.parse(l.kickOff)));
  if (now.getTime() < first - 60 * 60e3 || now.getTime() > last + 3 * 3600e3) return null;

  const ch = await getChannels(env);
  const channelId = ch.idFor("live-bets");
  if (!channelId) return null;
  const stateKey = `live:${today}`;
  const saved = (await kv.get<{ messages: Record<string, string>; hashes: Record<string, string> }>(stateKey, "json")) ?? { messages: {}, hashes: {} };
  if (!Object.keys(saved.messages).length) await cleanChannel(env, channelId, ch.botId, () => true); // new day – clear yesterday's

  let changed = 0;
  for (const bet of bets) {
    const views: LegView[] = [];
    for (const leg of bet.acca.legs) {
      const game = ESPN_SLUG[leg.code] ? await findEspnGame(leg.code, leg.kickOff, leg.oh ?? leg.home, leg.oa ?? leg.away) : undefined;
      const h = game?.teams.find((t) => t.side === "home")?.score ?? 0, a = game?.teams.find((t) => t.side === "away")?.score ?? 0;
      views.push({ leg, game, state: game ? liveState(leg.spec, h, a, game.state) : (Date.parse(leg.kickOff) > now.getTime() ? "todo" : "unknown") });
    }
    const embed = betEmbed(bet, views, today);
    const hash = embed.description;
    if (saved.hashes[bet.key] === hash) continue;
    const id = saved.messages[bet.key];
    if (id) await discord(env, "PATCH", `/channels/${channelId}/messages/${id}`, { embeds: [embed] });
    else {
      const msg: any = await discord(env, "POST", `/channels/${channelId}/messages`, { embeds: [embed] });
      if (msg?.id) saved.messages[bet.key] = msg.id;
    }
    saved.hashes[bet.key] = hash;
    changed++;
  }
  if (changed) await kv.put(stateKey, JSON.stringify(saved), { expirationTtl: 3 * 86400 });
  return changed ? `🔴 #live-bets – ${changed} updated` : null;
}
