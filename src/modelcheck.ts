// #model-check – every Tuesday (once corners and cards from the weekend are in): is Hawk's 70% really 70%?
// Compares what Hawk said with what happened, for last week and for all time.
// Only accuracy is measured – without bookies' prices there's no profit figure.

import { COLOUR, LEAGUES } from "./football";
import { discord, getChannels, cleanChannel, dublinDate, log, type DiscordEnv } from "./discord";
import type { GradedDay, GradedItem } from "./results";

export interface CheckEnv extends DiscordEnv { HAWK?: KVNamespace }

interface Tally { n: number; sumP: number; won: number }
interface AllTime {
  since: string;
  weeks: string[]; // weeks already added, so a re-run doesn't count a week twice
  bands: Record<string, Tally>; // single predictions (picks + builder legs) by chance band
  builders: Tally;
  accas: Tally;
  leagues: Record<string, Tally>; // picks by league
  gaps?: Gaps; // 📊 where the bookies' price was bigger than Hawk's fair price
}
interface Gaps { n: number; sumP: number; sumB: number; won: number; profit: number }
const noGaps = (): Gaps => ({ n: 0, sumP: 0, sumB: 0, won: 0, profit: 0 });

const BANDS = [
  { key: "90", label: "90%+", lo: 0.9, hi: 1.01 },
  { key: "80", label: "80–89%", lo: 0.8, hi: 0.9 },
  { key: "70", label: "70–79%", lo: 0.7, hi: 0.8 },
  { key: "60", label: "60–69%", lo: 0.6, hi: 0.7 },
  { key: "50", label: "50–59%", lo: 0.5, hi: 0.6 },
  { key: "0", label: "under 50%", lo: 0, hi: 0.5 },
];
const MIN_TO_JUDGE = 15;
const empty = (): Tally => ({ n: 0, sumP: 0, won: 0 });
const add = (t: Tally, i: GradedItem) => { t.n++; t.sumP += i.p; if (i.outcome === "won") t.won++; };
const merge = (a: Tally, b: Tally) => { a.n += b.n; a.sumP += b.sumP; a.won += b.won; };
const pc = (x: number) => `${Math.round(x * 100)}%`;
const settled = (i: GradedItem) => i.outcome === "won" || i.outcome === "lost";

function summarise(items: GradedItem[]) {
  const out = { bands: Object.fromEntries(BANDS.map((b) => [b.key, empty()])) as Record<string, Tally>, builders: empty(), accas: empty(), picks: empty(), leagues: {} as Record<string, Tally>, gaps: noGaps() };
  for (const i of items.filter(settled)) {
    if (i.kind === "pick" || i.kind === "leg") {
      const band = BANDS.find((b) => i.p >= b.lo && i.p < b.hi)!;
      add(out.bands[band.key], i);
    }
    if (i.kind === "pick") {
      add(out.picks, i);
      if (i.code) add((out.leagues[i.code] ??= empty()), i);
    }
    if (i.kind === "builder") add(out.builders, i);
    if (i.kind === "gap") {
      const g = out.gaps;
      g.n++; g.sumP += i.p; g.sumB += i.bookies ?? 0;
      if (i.outcome === "won") { g.won++; g.profit += (i.odds ?? 1) - 1; } else g.profit -= 1;
    }
    if (i.kind === "acca") add(out.accas, i);
  }
  return out;
}

// On target if the gap is small, or within what luck alone would explain for this many bets.
function verdict(t: Tally): { mark: string; text: string; off: number } {
  if (t.n < MIN_TO_JUDGE) return { mark: "⏳", text: "too few to judge yet", off: 0 };
  const expected = t.sumP / t.n, actual = t.won / t.n;
  const luck = 2 * Math.sqrt((expected * (1 - expected)) / t.n);
  const gap = actual - expected;
  if (Math.abs(gap) <= Math.max(0.05, luck)) return { mark: "✅", text: "on target", off: 0 };
  return gap < 0
    ? { mark: "⚠️", text: "Hawk was too confident", off: gap }
    : { mark: "🔼", text: "Hawk was too cautious", off: gap };
}

const vsExpected = (t: Tally) => `**${t.won}/${t.n}** (Hawk expected ${(t.sumP).toFixed(1)})`;

export async function runModelCheck(env: CheckEnv, now = new Date(), addToAllTime = true): Promise<string> {
  const ch = await getChannels(env);
  let line: string;
  try {
    if (!env.HAWK) throw new Error("storage not set up");
    const channelId = ch.idFor("model-check");
    if (!channelId) throw new Error("#model-check not found");

    // Last week = Monday to Sunday, finishing two days ago (run on Tuesdays).
    const dates = Array.from({ length: 7 }, (_, i) => dublinDate(new Date(now.getTime() - (8 - i) * 864e5)));
    const days = await Promise.all(dates.map((d) => env.HAWK!.get<GradedDay>(`results:${d}`, "json")));
    const items = days.flatMap((d) => d?.items ?? []);
    const week = summarise(items);

    const all: AllTime = (await env.HAWK.get<AllTime>("modelcheck:alltime", "json"))
      ?? { since: dates[0], weeks: [], bands: Object.fromEntries(BANDS.map((b) => [b.key, empty()])), builders: empty(), accas: empty(), leagues: {} };
    const weekId = dates[0];
    const combined: AllTime = JSON.parse(JSON.stringify(all));
    if (!all.weeks.includes(weekId)) {
      for (const b of BANDS) merge(combined.bands[b.key], week.bands[b.key]);
      merge(combined.builders, week.builders);
      merge(combined.accas, week.accas);
      for (const [code, t] of Object.entries(week.leagues)) merge((combined.leagues[code] ??= empty()), t);
      const g = (combined.gaps ??= noGaps());
      g.n += week.gaps.n; g.sumP += week.gaps.sumP; g.sumB += week.gaps.sumB; g.won += week.gaps.won; g.profit += week.gaps.profit;
      combined.weeks.push(weekId);
      if (addToAllTime) await env.HAWK.put("modelcheck:alltime", JSON.stringify(combined));
    }

    const LABEL = new Intl.DateTimeFormat("en-IE", { day: "numeric", month: "long", timeZone: "UTC" });
    const nice = (d: string) => LABEL.format(new Date(`${d}T12:00:00Z`));
    const weekLabel = `${nice(dates[0])} – ${nice(dates[6])}`;

    // This week
    const thisWeek = week.picks.n
      ? [
          `🎯 Picks ${vsExpected(week.picks)}`,
          week.builders.n ? `🧩 Builders ${vsExpected(week.builders)}` : "",
          week.accas.n ? `🎟️ Accas ${vsExpected(week.accas)}` : "",
        ].filter(Boolean).join("\n")
      : "No graded picks this week.";

    // Is 70% really 70%?
    const bandLines = BANDS.map((b) => {
      const t = combined.bands[b.key];
      if (!t.n) return null;
      const v = verdict(t);
      return `\`${b.label.padEnd(9)}\` ${t.n} bets · landed **${pc(t.won / t.n)}** (said ${pc(t.sumP / t.n)}) ${v.mark} ${v.text}`;
    }).filter(Boolean);
    const groupLine = (name: string, t: Tally) => {
      if (!t.n) return null;
      const v = verdict(t);
      return `${name}: ${t.n} · landed **${pc(t.won / t.n)}** (said ${pc(t.sumP / t.n)}) ${v.mark} ${v.text}`;
    };
    const leagueLines = Object.entries(combined.leagues)
      .sort((a, b) => b[1].n - a[1].n)
      .map(([code, t]) => `${LEAGUES[code]?.name ?? code} ${t.won}/${t.n} (${pc(t.won / t.n)}, said ${pc(t.sumP / t.n)})`);

    // 📊 Hawk v the bookies, where they disagreed
    const G = combined.gaps;
    const gapLines = G && G.n
      ? [
          "",
          `**📊 When the bookies' price was bigger than Hawk's fair price** _(${G.n} times)_`,
          `It landed **${pc(G.won / G.n)}** – Hawk said ${pc(G.sumP / G.n)}, the bookies said ${pc(G.sumB / G.n)}. ` +
            `${Math.abs(G.won / G.n - G.sumP / G.n) < Math.abs(G.won / G.n - G.sumB / G.n) ? "**Hawk** was closer" : "**The bookies** were closer"}${G.n < 30 ? " _(too few to read much into yet)_" : ""}.`,
          `At the best price: **${G.profit >= 0 ? "+" : "−"}${Math.abs(G.profit).toFixed(1)} units** from ${G.n} 1-unit stakes.`,
        ]
      : [];

    // Plain-English summary
    const judged = BANDS.map((b) => ({ b, v: verdict(combined.bands[b.key]) })).filter((x) => x.v.mark !== "⏳");
    const worst = judged.filter((x) => x.v.mark === "⚠️").sort((x, y) => x.v.off - y.v.off)[0];
    const totalBets = BANDS.reduce((s, b) => s + combined.bands[b.key].n, 0);
    const summary = !judged.length
      ? `🧪 Early days – ${totalBets} graded so far. Each band needs ${MIN_TO_JUDGE}+ bets before Hawk can judge it, and ~100 before it's really reliable.`
      : worst
        ? `⚠️ Hawk has been **too confident on ${worst.b.label} picks** – they landed ${pc(combined.bands[worst.b.key].won / combined.bands[worst.b.key].n)} of the time when Hawk said ${pc(combined.bands[worst.b.key].sumP / combined.bands[worst.b.key].n)}. Treat those with extra caution.`
        : "✅ So far Hawk's percentages are holding up – when it says 70%, it's landing about 70% of the time.";

    const embed = {
      title: `🧪 Model check – ${weekLabel}`,
      description: [
        "**Last week**",
        thisWeek,
        "",
        `**Is Hawk's 70% really 70%?** _(every pick and builder leg since ${nice(combined.since)})_`,
        ...(bandLines.length ? bandLines : ["Nothing graded yet."]),
        "",
        ...[groupLine("🧩 Builders", combined.builders), groupLine("🎟️ Accas", combined.accas)].filter(Boolean),
        ...(leagueLines.length ? ["", `**Picks by league:** ${leagueLines.join(" · ")}`] : []),
        ...gapLines,
        "",
        summary,
      ].join("\n"),
      color: COLOUR,
      footer: { text: `✅ on target · ⚠️ too confident · 🔼 too cautious · ⏳ under ${MIN_TO_JUDGE} bets · Accuracy only – no odds, so no profit figure · Powered by Hawk 🦅` },
    };

    const embeds: any[] = [embed];
    const bt = await env.HAWK.get<any>("backtest:summary", "json");
    if (bt) embeds.push(backtestEmbed(bt));
    await cleanChannel(env, channelId, ch.botId, (m) => (m.embeds?.[0]?.title ?? "").includes(weekLabel));
    await discord(env, "POST", `/channels/${channelId}/messages`, { embeds });
    line = `✅ #model-check – ${weekLabel}: ${items.filter(settled).length} graded this week, ${totalBets} all time`;
  } catch (err: any) {
    line = `⚠️ #model-check – failed: ${err.message}`;
  }
  await log(env, ch, `🧪 ${line}`);
  return line;
}

// 📚 The backtest – Hawk replayed over last season and this one, on your PC.
function backtestEmbed(bt: any) {
  const pc = (a: number, b: number) => (b ? `${Math.round((100 * a) / b)}%` : "–");
  const label = (c: string) => `20${c.slice(0, 2)}/${c.slice(2)}`;
  const leagues = Object.entries(bt.leagues as Record<string, any>).map(([code, L]) => {
    const v = L.value;
    const value = v.bets ? ` · 💰 value bets ${v.bets}: ${v.profit >= 0 ? "+" : ""}${v.profit} units (${pc(v.profit, v.bets)})` : "";
    return `**${LEAGUES[code]?.name ?? code}** · ${L.games} games · Hawk's pick right **${pc(L.hawkRight, L.games)}** (bookies' favourite ${pc(L.bookiesRight, L.bookiesGames)})${value}`;
  });
  const bands = Object.entries(bt.bands as Record<string, [number, number, number]>)
    .filter(([, t]) => t[0])
    .map(([b, [n, sumP, won]]) => {
      const v = verdict({ n, sumP, won });
      return `\`${b.padEnd(7)}\` ${n} legs · landed **${pc(won, n)}** (said ${pc(sumP, n)}) ${v.mark}`;
    });
  return {
    title: `📚 Backtest – ${bt.seasons.map(label).join(" and ")} so far`,
    description: [
      "_Every game replayed using only what Hawk would have known before kick-off._",
      "",
      ...leagues,
      "",
      "**Is Hawk's 70% really 70%?** _(every market, 50%+ legs)_",
      ...bands,
      "",
      `💰 _Value bet = Hawk rated a result ${Math.round(bt.valueEdge * 100)}+ points above the bookies' average price, staked 1 unit at that price._`,
      "",
      bt.edges?.length
        ? `**🎯 Edges that held up over two full seasons:** ${bt.edges.map((e: any) => `${e.market} when Hawk is ${Math.round(e.edge * 100)}+ pts above the bookies (${pc(e.found.profit, e.found.bets)} then ${pc(e.check.profit, e.check.bets)})`).join(" · ")}`
        : "**🎯 Edges:** none held up over two full seasons yet – Hawk shows the bookies' prices but doesn't call anything value.",
    ].join("\n"),
    color: COLOUR,
    footer: { text: `Run on ${new Date(bt.generated).toLocaleDateString("en-IE")} · Powered by Hawk 🦅` },
  };
}
