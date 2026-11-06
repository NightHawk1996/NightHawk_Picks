// #team-news – confirmed line-ups about an hour before kick-off, for every game in today's bets.
// Shows each XI, what changed from that team's last XI Hawk saw, and any regular starter missing
// (once Hawk has seen a few of their line-ups). Facts only – no write-ups.
// Line-ups come from ESPN's public app data (unofficial – the owner accepted that).

import { discord, getChannels, dublinDate, log, type DiscordEnv } from "./discord";
import { BASE, ESPN_SLUG, espnText, findEspnGame, type EspnGame } from "./espn";
import { clean } from "./history";
import { todaysBets, betGames, type LiveBet } from "./livebets";
import { ACCA_NAMES } from "./acca";
import { LEAGUES, COLOUR } from "./football";
import { pct } from "./model";
import type { StoredAccaLeg } from "./store";

export interface LineupEnv extends DiscordEnv { HAWK?: KVNamespace }
const MAX_PER_RUN = 3; // each line-up is a big download – keeps a run inside Cloudflare's CPU allowance
const KEEP = 5;        // XIs remembered per team

export interface Xi { team: string; side: "home" | "away"; formation?: string; starters: { name: string; pos: string }[] }

// Pulls just the "rosters" part out of ESPN's (large) match summary and reads that
export function lineupsFromSummary(text: string): Xi[] {
  const start = text.indexOf('"rosters":[');
  if (start < 0) return [];
  let i = text.indexOf("[", start), depth = 0, inStr = false;
  const from = i;
  for (; i < text.length; i++) {
    const c = text[i];
    if (inStr) { if (c === "\\") i++; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === "[" || c === "{") depth++;
    else if (c === "]" || c === "}") { depth--; if (depth === 0) break; }
  }
  let rosters: any[];
  try { rosters = JSON.parse(text.slice(from, i + 1)); } catch { return []; }
  return rosters.map((r) => {
    const starters = (r.roster ?? []).filter((p: any) => p.starter)
      .sort((a: any, b: any) => Number(a.formationPlace ?? 99) - Number(b.formationPlace ?? 99))
      .map((p: any) => ({ name: p.athlete?.displayName ?? p.athlete?.shortName ?? "?", pos: String(p.position?.abbreviation ?? "") }));
    return { team: r.team?.displayName ?? r.team?.name ?? "?", side: r.homeAway, formation: r.formation, starters };
  });
}

// "Raya; White, Saliba, Gabriel, Calafiori; Rice, Ødegaard, Merino; Saka, Havertz, Martinelli"
const group = (pos: string) => /^G/.test(pos) ? 0 : /M/.test(pos) ? 2 : /D|B$/.test(pos) ? 1 : /F|W|S/.test(pos) ? 3 : 2;
export function xiLine(xi: Xi): string {
  const known = xi.starters.every((p) => p.pos);
  if (!known) return xi.starters.map((p) => p.name).join(", ");
  const rows: string[][] = [[], [], [], []];
  for (const p of xi.starters) rows[group(p.pos)].push(p.name);
  return rows.filter((r) => r.length).map((r) => r.join(", ")).join("; ");
}

// What changed since the last XI Hawk saw for this team, and which regulars are missing
export function changes(now: string[], history: string[][]): string[] {
  const out: string[] = [];
  const last = history[0];
  if (!last) return ["_First line-up Hawk has seen for them – changes show from next time._"];
  const gone = last.filter((n) => !now.includes(n)), came = now.filter((n) => !last.includes(n));
  out.push(gone.length ? `🔁 Changes from last time: **out** ${gone.join(", ")} · **in** ${came.join(", ")}` : "🔁 Same XI as last time");
  if (history.length >= 4) {
    const regulars = [...new Set(history.flat())].filter((n) => history.filter((x) => x.includes(n)).length >= Math.ceil(history.length * 0.8));
    const missing = regulars.filter((n) => !now.includes(n));
    if (missing.length) out.push(`⚠️ **Regular starter${missing.length > 1 ? "s" : ""} missing:** ${missing.map((n) => `${n} (started ${history.filter((x) => x.includes(n)).length} of last ${history.length})`).join(", ")}`);
  }
  return out;
}

const teamKey = (code: string, name: string) => `xi:${code}:${clean(name).replace(/ /g, "-")}`;

function betsOnGame(bets: LiveBet[], g: StoredAccaLeg): string[] {
  const out: string[] = [];
  for (const b of bets) for (const l of b.acca.legs) {
    if (l.code === g.code && l.homeId === g.homeId && l.awayId === g.awayId) out.push(`${ACCA_NAMES[b.acca.kind ?? "daily"]}: **${l.label}** (${pct(l.p)})`);
  }
  return out;
}

export async function runLineups(env: LineupEnv, now = new Date()): Promise<string | null> {
  if (!env.HAWK) return null;
  const kv = env.HAWK;
  const today = dublinDate(now);
  const bets = await todaysBets(kv, now);
  // Games kicking off in the next 15–75 minutes, not yet posted
  const due = betGames(bets, today).filter((g) => {
    const mins = (Date.parse(g.kickOff) - now.getTime()) / 60e3;
    return mins >= 10 && mins <= 75 && ESPN_SLUG[g.code];
  });
  if (!due.length) return null;
  const ch = await getChannels(env);
  const channelId = ch.idFor("team-news");
  if (!channelId) return null;

  const posted: string[] = [];
  let tried = 0;
  for (const g of due) {
    const flag = `xi-posted:${today}:${g.code}:${g.homeId}:${g.awayId}`;
    if (await kv.get(flag)) continue;
    if (tried++ >= MAX_PER_RUN) break;
    const game: EspnGame | undefined = await findEspnGame(g.code, g.kickOff, g.oh ?? g.home, g.oa ?? g.away);
    if (!game) continue;
    const text = await espnText(`${BASE}/${ESPN_SLUG[g.code]}/summary?event=${game.id}`);
    const xis = text ? lineupsFromSummary(text).filter((x) => x.starters.length >= 11) : [];
    if (xis.length < 2) continue; // not announced yet – the next run tries again

    const lines: string[] = [];
    for (const side of ["home", "away"] as const) {
      const xi = xis.find((x) => x.side === side)!;
      const names = xi.starters.map((p) => p.name);
      const key = teamKey(g.code, side === "home" ? g.home : g.away);
      const history = (await kv.get<string[][]>(key, "json")) ?? [];
      lines.push(`**${side === "home" ? g.home : g.away}**${xi.formation ? ` (${xi.formation})` : ""}: ${xiLine(xi)}`, ...changes(names, history), "");
      await kv.put(key, JSON.stringify([names, ...history].slice(0, KEEP)), { expirationTtl: 400 * 86400 });
    }
    const onIt = betsOnGame(bets, g);
    await discord(env, "POST", `/channels/${channelId}/messages`, {
      embeds: [{
        title: `📋 ${g.home} v ${g.away} – line-ups`,
        description: [`${LEAGUES[g.code]?.emoji ?? "⚽"} Kick-off <t:${Math.floor(Date.parse(g.kickOff) / 1000)}:t>`, "", ...lines, ...(onIt.length ? ["🎯 **Hawk's bets on this game:**", ...onIt.map((x) => `• ${x}`)] : [])].join("\n").slice(0, 4000),
        color: COLOUR,
        footer: { text: "Confirmed line-ups · Hawk's percentages were set this morning, before these were known · Powered by Hawk 🦅" },
      }],
    });
    await kv.put(flag, "1", { expirationTtl: 2 * 86400 });
    posted.push(`${g.home} v ${g.away}`);
  }
  if (!posted.length) return null;
  const line = `📋 #team-news – line-ups posted: ${posted.join(" · ")}`;
  await log(env, ch, line);
  return line;
}
