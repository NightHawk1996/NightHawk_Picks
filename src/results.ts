// #results – grades every pick, bet builder and acca leg Hawk posted, against the final
// score. Bets are settled on the 90-minute score, like the bookies, and postponed games
// are void. Graded results are saved so #model-check can test Hawk's percentages.

import { getResults, LEAGUES, COLOUR, type Match } from "./football";
import { gradeLeg, pct } from "./model";
import { discord, getChannels, cleanChannel, log, type DiscordEnv } from "./discord";
import type { StoredDay, StoredAcca, StoredGame } from "./store";
import { loadPicks } from "./store";

export interface ResultsEnv extends DiscordEnv {
  FOOTBALL_DATA_TOKEN: string;
  HAWK?: KVNamespace;
}

type Outcome = "won" | "lost" | "void" | "pending";
const MARK: Record<Outcome, string> = { won: "✅", lost: "❌", void: "➖", pending: "⏳" };
const VOID = ["POSTPONED", "CANCELLED", "SUSPENDED", "AWARDED"];

// What #model-check needs later: every graded chance and what happened.
export interface GradedItem { kind: "pick" | "builder" | "acca" | "leg"; p: number; outcome: Outcome; code?: string }
export interface GradedDay { date: string; items: GradedItem[] }

const nextDay = (date: string) => new Date(Date.parse(`${date}T12:00:00Z`) + 864e5).toISOString().slice(0, 10);
const LABEL = new Intl.DateTimeFormat("en-IE", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
const dateLabel = (date: string) => LABEL.format(new Date(`${date}T12:00:00Z`)).replace(",", "");

interface Final { status: "done" | "void" | "pending"; h: number; a: number }

function finalScore(results: Match[], g: { homeId: number; awayId: number; kickOff: string }): Final {
  const m = results.find((x) => x.homeTeam.id === g.homeId && x.awayTeam.id === g.awayId && x.utcDate.slice(0, 10) >= g.kickOff.slice(0, 10))
    ?? results.find((x) => x.homeTeam.id === g.homeId && x.awayTeam.id === g.awayId);
  if (!m) return { status: "pending", h: 0, a: 0 };
  if (VOID.includes(m.status)) return { status: "void", h: 0, a: 0 };
  if (m.status !== "FINISHED") return { status: "pending", h: 0, a: 0 };
  const s = m.score?.duration && m.score.duration !== "REGULAR" && m.score.regularTime?.home != null ? m.score.regularTime : m.score?.fullTime;
  if (!s || s.home == null || s.away == null) return { status: "pending", h: 0, a: 0 };
  return { status: "done", h: s.home, a: s.away };
}

const legOutcome = (f: Final, spec: any): Outcome =>
  f.status === "void" ? "void" : f.status === "pending" ? "pending" : gradeLeg(spec, f.h, f.a) ? "won" : "lost";

const scoreLine = (g: { home: string; away: string }, f: Final) =>
  f.status === "done" ? `**${g.home} ${f.h}-${f.a} ${g.away}**` : `**${g.home} v ${g.away}**`;

// Several legs together (builder or acca): any loss loses it; void legs drop out, like the bookies.
function combine(outcomes: Outcome[]): Outcome {
  if (outcomes.includes("lost")) return "lost";
  if (outcomes.includes("pending")) return "pending";
  if (outcomes.every((o) => o === "void")) return "void";
  return "won";
}

// ---------------------------------------------------------------------------
export async function gradeDay(env: ResultsEnv, date: string) {
  if (!env.HAWK) throw new Error("storage not set up");
  const days = (await loadPicks(env.HAWK, date)).filter((d) => d.games.length);
  const acca = await env.HAWK.get<StoredAcca>(`acca:${date}`, "json");

  // One small results request per league that had picks (or acca legs).
  const codes = new Set([...days.map((d) => d.code), ...(acca?.legs.map((l) => l.code) ?? [])]);
  const results: Record<string, Match[]> = {};
  for (const code of codes) results[code] = await getResults(code, env.FOOTBALL_DATA_TOKEN, date, nextDay(date));

  const items: GradedItem[] = [];
  const embeds: any[] = [];

  for (const day of days.sort((x, y) => Object.keys(LEAGUES).indexOf(x.code) - Object.keys(LEAGUES).indexOf(y.code))) {
    const l = LEAGUES[day.code];
    const picks: string[] = [];
    const builders: string[] = [];
    for (const g of [...day.games].sort((x, y) => x.kickOff.localeCompare(y.kickOff))) {
      const f = finalScore(results[day.code], g);
      const po = legOutcome(f, g.pick.spec);
      items.push({ kind: "pick", p: g.pick.p, outcome: po, code: day.code });
      const note = f.status === "void" ? " – postponed, void" : f.status === "pending" ? " – not finished yet" : "";
      picks.push(`${MARK[po]} ${scoreLine(g, f)} · ${g.pick.label} ${pct(g.pick.p)}${note}`);

      if (g.builder) {
        const legs = g.builder.legs.map((x) => ({ ...x, o: legOutcome(f, x.spec) }));
        for (const x of legs) items.push({ kind: "leg", p: x.p, outcome: x.o, code: day.code });
        const bo = combine(legs.map((x) => x.o));
        items.push({ kind: "builder", p: g.builder.p, outcome: bo, code: day.code });
        const byOne = bo === "lost" && legs.filter((x) => x.o === "lost").length === 1;
        const word = bo === "won" ? "landed" : byOne ? "lost by one leg" : bo;
        builders.push(
          `${scoreLine(g, f)} → ${MARK[bo]} **${word}** (${pct(g.builder.p)})\n` +
          legs.map((x) => `${MARK[x.o]} ${x.label}`).join("\n"),
        );
      }
    }
    const description = [`**🎯 Picks**`, ...picks, ...(builders.length ? ["", "**🧩 Bet builders**", builders.join("\n\n")] : [])].join("\n");
    embeds.push({ title: `📈 ${l.emoji} ${l.name} – ${dateLabel(date)}`, description: description.slice(0, 4000), color: COLOUR });
  }

  // The acca
  let accaOutcome: Outcome | null = null;
  if (acca) {
    const legs = acca.legs.map((x) => {
      const f = finalScore(results[x.code] ?? [], x);
      return { ...x, f, o: legOutcome(f, x.spec) };
    });
    for (const x of legs) items.push({ kind: "leg", p: x.p, outcome: x.o, code: x.code });
    accaOutcome = combine(legs.map((x) => x.o));
    items.push({ kind: "acca", p: acca.p, outcome: accaOutcome });
    const lost = legs.filter((x) => x.o === "lost").length;
    const headline = accaOutcome === "won" ? "✅ **Landed!**" : accaOutcome === "lost" ? `❌ **Lost**${lost === 1 ? " – by one leg" : ` – ${lost} legs let it down`}` : `${MARK[accaOutcome]} **${accaOutcome}**`;
    embeds.push({
      title: `🎟️ Hawk's Acca – ${dateLabel(date)}`,
      description: `${legs.length} legs · ${pct(acca.p)} together → ${headline}\n\n` +
        legs.map((x) => `${MARK[x.o]} ${scoreLine(x, x.f)} · ${x.label} ${pct(x.p)}`).join("\n"),
      color: COLOUR,
    });
  }

  // The tally
  const count = (kind: GradedItem["kind"], filter = (_: GradedItem) => true) => {
    const settled = items.filter((i) => i.kind === kind && filter(i) && (i.outcome === "won" || i.outcome === "lost"));
    return { won: settled.filter((i) => i.outcome === "won").length, total: settled.length };
  };
  const picks = count("pick"), strong = count("pick", (i) => i.p >= 0.7), builders = count("builder");
  const tally = [
    `🎯 Picks **${picks.won}/${picks.total}**` + (strong.total ? ` (✅ 70%+ picks: **${strong.won}/${strong.total}**)` : ""),
    builders.total ? `🧩 Builders **${builders.won}/${builders.total}**` : "",
    accaOutcome ? `🎟️ Acca ${MARK[accaOutcome]}` : "",
  ].filter(Boolean).join(" · ");
  const pending = items.some((i) => i.outcome === "pending") ? "\n⏳ Some games hadn't finished – they'll count once they have." : "";
  if (embeds.length) {
    embeds.push({
      title: `📊 ${dateLabel(date)} – how Hawk did`,
      description: tally + pending,
      color: COLOUR,
      footer: { text: "Settled on the 90-minute score · postponed = void · Powered by Hawk 🦅" },
    });
  }
  return { date, embeds, items, tally };
}

// True if a day's saved results still has games that hadn't finished.
export async function hasPending(env: ResultsEnv, date: string): Promise<boolean> {
  const saved = await env.HAWK?.get<GradedDay>(`results:${date}`, "json");
  return !!saved?.items.some((i) => i.outcome === "pending");
}

// Posts a day's results to #results (replacing an earlier run for the same day) and
// saves the graded items for #model-check.
export async function runResultsPost(env: ResultsEnv, date: string): Promise<string> {
  const ch = await getChannels(env);
  let line: string;
  try {
    const channelId = ch.idFor("results");
    if (!channelId) throw new Error("#results not found");
    const r = await gradeDay(env, date);
    if (!r.embeds.length) {
      line = `💤 #results – no picks saved for ${dateLabel(date)}`;
    } else {
      const label = dateLabel(date);
      await cleanChannel(env, channelId, ch.botId, (m) => (m.embeds ?? []).some((e: any) => (e.title ?? "").includes(label)));
      // Discord allows up to 10 embeds and 6,000 characters per message, so send in batches.
      let batch: any[] = [], size = 0;
      const flush = async () => { if (batch.length) await discord(env, "POST", `/channels/${channelId}/messages`, { embeds: batch }); batch = []; size = 0; };
      for (const e of r.embeds) {
        const len = (e.title?.length ?? 0) + (e.description?.length ?? 0) + (e.footer?.text?.length ?? 0);
        if (batch.length === 10 || size + len > 5800) await flush();
        batch.push(e); size += len;
      }
      await flush();
      await env.HAWK!.put(`results:${date}`, JSON.stringify({ date, items: r.items } as GradedDay), { expirationTtl: 60 * 60 * 24 * 400 });
      line = `✅ #results – ${label}: ${r.tally.replace(/\*\*/g, "")}`;
    }
  } catch (err: any) {
    line = `⚠️ #results – failed: ${err.message}`;
  }
  await log(env, ch, `📈 ${line}`);
  return line;
}
