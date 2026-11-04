// Hawk's reasoning: the 🔍 Why? menus and buttons, the full explanation for one match,
// and the short daily summary for #hawk-reasoning. Everything here is worked out from
// Hawk's own numbers – nothing is made up.

import type { GameOdds } from "./odds";
import {
  COLOUR, getMatches, predictMatch, pickOf, teamName, league, formFor, dots, fitLines, gapLine,
  type Match, type Predicted,
} from "./football";
import { buildRatings, light, pct, fairOdds, type Ratings } from "./model";

// ---------------------------------------------------------------------------
// Menus and buttons. The custom ID carries the league and the moment the post was
// made, so the explanation is rebuilt from exactly the data Hawk used at the time.
// ---------------------------------------------------------------------------
export function whyMenu(code: string, postedAt: Date, list: { m: Match; p: Predicted }[], kind: "fx" | "bb") {
  if (list.length === 0) return [];
  const ts = Math.floor(postedAt.getTime() / 1000);
  return [{
    type: 1,
    components: [{
      type: 3,
      custom_id: `why:${kind}:${code}:${ts}`,
      placeholder: "🔍 Why? Pick a game to see Hawk's reasoning",
      options: list.slice(0, 25).map(({ m, p }) => ({
        label: `${p.homeName} v ${p.awayName}`.slice(0, 100),
        value: `${m.homeTeam.id}-${m.awayTeam.id}`,
        description: (kind === "bb" && p.builder
          ? `Builder: ${pct(p.builder.p)} together`
          : `${pickOf(p).label} ${pct(pickOf(p).p)} · likely ${p.likely.h}-${p.likely.a}`).slice(0, 100),
      })),
    }],
  }];
}

export function whyButton(code: string, postedAt: Date, homeId: number, awayId: number) {
  const ts = Math.floor(postedAt.getTime() / 1000);
  return [{
    type: 1,
    components: [{ type: 2, style: 2, label: "🔍 Why?", custom_id: `why:pr:${code}:${ts}:${homeId}-${awayId}` }],
  }];
}

// Reads a menu choice or button press back into what to explain.
export function parseWhy(customId: string, values?: string[]) {
  let [tag, kind, code, ts, pair] = customId.split(":");
  if (tag !== "why") return null;
  // Acca legs come from different leagues, so each option carries its own league and time.
  if (kind === "ac") [code, ts, pair] = (values?.[0] ?? "").split(":");
  const [homeId, awayId] = (pair ?? values?.[0] ?? "").split("-").map(Number);
  if (!code || !ts || !homeId || !awayId) return null;
  return { kind, code, postedAt: new Date(Number(ts) * 1000), homeId, awayId };
}

// ---------------------------------------------------------------------------
// Team numbers in plain English
// ---------------------------------------------------------------------------
const signed = (x: number) => `${x >= 0 ? "+" : "−"}${Math.abs(Math.round(x * 100))}%`;

function attackText(r: Ratings, id: number) {
  const a = r.attack.get(id) ?? 1;
  if (Math.abs(a - 1) < 0.05) return "about average";
  return `${Math.round(Math.abs(a - 1) * 100)}% ${a > 1 ? "better" : "worse"} than average`;
}
function defenceText(r: Ratings, id: number) {
  const d = r.defence.get(id) ?? 1; // above 1 = concedes more than average
  if (Math.abs(d - 1) < 0.05) return "about average";
  return `concedes ${Math.round(Math.abs(d - 1) * 100)}% ${d > 1 ? "more" : "less"} than average`;
}

function rawStats(id: number, matches: Match[], before: Date) {
  let games = 0, gf = 0, ga = 0;
  const home = { w: 0, d: 0, l: 0 }, away = { w: 0, d: 0, l: 0 };
  for (const m of matches) {
    if (m.status !== "FINISHED" || new Date(m.utcDate) >= before) continue;
    const ft = m.score?.fullTime;
    if (!ft || ft.home == null || ft.away == null) continue;
    const isHome = m.homeTeam.id === id, isAway = m.awayTeam.id === id;
    if (!isHome && !isAway) continue;
    const f = isHome ? ft.home : ft.away, a = isHome ? ft.away : ft.home;
    games++; gf += f; ga += a;
    const rec = isHome ? home : away;
    if (f > a) rec.w++; else if (f === a) rec.d++; else rec.l++;
  }
  const rec = (x: typeof home) => (x.w + x.d + x.l ? `W${x.w} D${x.d} L${x.l}` : "no games");
  return {
    games,
    scored: games ? (gf / games).toFixed(1) : "–",
    conceded: games ? (ga / games).toFixed(1) : "–",
    home: rec(home),
    away: rec(away),
  };
}

// ---------------------------------------------------------------------------
// Why each builder leg is there
// ---------------------------------------------------------------------------
function legReason(label: string, family: string, p: Predicted): string {
  const total = (p.xgHome + p.xgAway).toFixed(1);
  const h = p.homeName, a = p.awayName;
  if (family === "result") {
    if (label.endsWith(" or draw")) {
      const team = label.replace(" or draw", "");
      return `covers the draw (${pct(p.draw)}) as well as ${team} winning`;
    }
    if (label.endsWith(" win")) return "Hawk's favourite result";
    return "";
  }
  if (family === "goals") return label.startsWith("Over") ? `Hawk expects ${total} goals in total` : `Hawk expects only ${total} goals in total`;
  if (family === "btts") {
    return label.endsWith("No")
      ? `at least one side expected to struggle (${Math.min(p.xgHome, p.xgAway).toFixed(1)} expected goals)`
      : `both sides expected to score (${p.xgHome.toFixed(1)} and ${p.xgAway.toFixed(1)})`;
  }
  // Team goal legs
  const homeSide = family === "home-goals";
  const team = homeSide ? h : a;
  const xg = (homeSide ? p.xgHome : p.xgAway).toFixed(1);
  if (label.endsWith("clean sheet")) return `${team} expected only ${xg} goals`;
  const leg = p.legs.find((x) => x.label === label);
  if (label.endsWith("to score") && leg) return `${team} expected ${xg} goals – they draw a blank in only ${pct(1 - leg.p)} of outcomes`;
  return `${team} expected ${xg} goals`;
}

// ---------------------------------------------------------------------------
// The full explanation for one match (ephemeral reply to 🔍 Why?)
// ---------------------------------------------------------------------------
export async function explainMatch(code: string, token: string, postedAt: Date, homeId: number, awayId: number, history: Match[] = [], oddsGames: GameOdds[] = []) {
  const l = league(code);
  const matches = await getMatches(code, token, postedAt);
  const cutoff = postedAt.toISOString();
  const m = matches
    .filter((x) => x.homeTeam.id === homeId && x.awayTeam.id === awayId && x.utcDate >= cutoff.slice(0, 19))
    .sort((x, y) => x.utcDate.localeCompare(y.utcDate))[0];
  if (!m) throw new Error("Couldn't find that game any more – it may have been rescheduled.");

  const ratings = buildRatings([...history, ...matches], postedAt);
  const p = predictMatch(ratings, m, oddsGames);
  const pick = pickOf(p);
  const kickOff = new Date(m.utcDate);
  const hs = rawStats(homeId, matches, postedAt), as = rawStats(awayId, matches, postedAt);

  const lines = [
    `**The pick:** ${pick.label} **${pct(pick.p)}** ${light(pick.p)} – ${p.homeName} ${pct(p.home)} · Draw ${pct(p.draw)} · ${p.awayName} ${pct(p.away)}`,
    "",
    "**How Hawk got there**",
    `⚔️ **${p.homeName} attack:** ${attackText(ratings, homeId)} – scoring ${hs.scored} a game`,
    `🛡️ **${p.homeName} defence:** ${defenceText(ratings, homeId)} – letting in ${hs.conceded} a game`,
    `⚔️ **${p.awayName} attack:** ${attackText(ratings, awayId)} – scoring ${as.scored} a game`,
    `🛡️ **${p.awayName} defence:** ${defenceText(ratings, awayId)} – letting in ${as.conceded} a game`,
    `🏠 ${p.homeName} at home: ${hs.home} · ✈️ ${p.awayName} away: ${as.away}`,
    `📈 Form: ${dots(formFor(homeId, matches, kickOff))}  v  ${dots(formFor(awayId, matches, kickOff))}`,
    `🧮 Put together: expected goals **${p.xgHome.toFixed(1)} – ${p.xgAway.toFixed(1)}**, most likely score **${p.likely.h}-${p.likely.a}** (${pct(p.likely.p)})`,
    `_"Better/worse than average" allows for who each team has played${history.length ? " (this season and last)" : ""}, and recent games count more. Goals per game are from recent games._`,
  ];

  if (p.odds) {
    const c = p.odds.chance;
    lines.push(
      "",
      "**Hawk v the bookies**",
      `The bookies make it ${p.homeName} **${pct(c.H)}** · Draw **${pct(c.D)}** · ${p.awayName} **${pct(c.A)}** (margin removed).`,
      ...(p.gaps.length
        ? [...p.gaps.map(gapLine), "When they disagree like this, the bookies have usually been right in Hawk's testing – they can see team news Hawk can't. Worth checking before deciding."]
        : ["Hawk and the bookies broadly agree here."]),
    );
  }

  if (p.builder) {
    const b = p.builder;
    const multiplied = b.legs.reduce((s, x) => s * x.p, 1);
    const linked = b.p - multiplied > 0.01
      ? `the legs help each other, so it's more likely than multiplying them (${pct(multiplied)}) suggests`
      : b.p - multiplied < -0.01
        ? `the legs pull against each other a little, so it's less likely than multiplying them (${pct(multiplied)}) suggests`
        : "these legs barely affect each other";
    lines.push(
      "",
      "**The bet builder**",
      ...b.legs.map((x) => {
        const why = legReason(x.label, x.family, p);
        return `• **${x.label}** (${pct(x.p)})${why ? ` – ${why}` : ""}`;
      }),
      `Together **${pct(b.p)}** – ${linked}. Hawk's fair price **${fairOdds(b.p)}**.`,
    );
  }

  lines.push(
    "",
    `⚠️ **What Hawk can't see:** injuries, team news or the referee. Rated on ${p.dataGames} game${p.dataGames === 1 ? "" : "s"} for the side with the fewest${p.dataGames < 6 ? " – early days, so treat with care" : ""}.`,
  );

  return {
    title: `🔍 Why: ${p.homeName} v ${p.awayName}`,
    description: `${l.emoji} ${l.name} · <t:${Math.floor(kickOff.getTime() / 1000)}:f>\n\n${lines.join("\n")}`,
    color: COLOUR,
    footer: { text: "Only you can see this · Powered by Hawk 🦅" },
  };
}

// ---------------------------------------------------------------------------
// The daily #hawk-reasoning summary: one line per game
// ---------------------------------------------------------------------------
function keyFactors(p: Predicted, r: Ratings, homeId: number, awayId: number): string {
  const pick = pickOf(p);
  if (pick.label === "Draw") return `evenly matched (expected goals ${p.xgHome.toFixed(1)}–${p.xgAway.toFixed(1)})`;
  const homePick = pick.label === p.homeName;
  const [t, o, tId, oId] = homePick ? [p.homeName, p.awayName, homeId, awayId] : [p.awayName, p.homeName, awayId, homeId];
  const factors: { size: number; text: string }[] = [];
  const att = (id: number) => r.attack.get(id) ?? 1, def = (id: number) => r.defence.get(id) ?? 1;
  if (att(tId) > 1.1) factors.push({ size: att(tId) - 1, text: `${t} attack ${signed(att(tId) - 1)}` });
  if (def(oId) > 1.1) factors.push({ size: def(oId) - 1, text: `${o} defence leaky (${signed(def(oId) - 1)} conceded)` });
  if (def(tId) < 0.9) factors.push({ size: 1 - def(tId), text: `${t} defence tight (${signed(def(tId) - 1)} conceded)` });
  if (att(oId) < 0.9) factors.push({ size: 1 - att(oId), text: `${o} attack blunt (${signed(att(oId) - 1)})` });
  factors.sort((x, y) => y.size - x.size);
  const top = factors.slice(0, 2).map((f) => f.text);
  if (top.length === 0) top.push(homePick ? "home advantage tips a close one" : "slight edge despite playing away");
  return top.join(", ");
}

export function summaryEmbed(code: string, list: { m: Match; p: Predicted }[], ratings: Ratings) {
  if (list.length === 0) return null;
  const l = league(code);
  const blocks = list.map(({ m, p }) => {
    const pick = pickOf(p);
    return `**${p.homeName} v ${p.awayName}** → **${pick.label} ${pct(pick.p)}** ${light(pick.p)}\n　${keyFactors(p, ratings, m.homeTeam.id, m.awayTeam.id)}\n`;
  });
  return {
    title: `🔍 ${l.emoji} ${l.name} – why today's picks`,
    description: fitLines(blocks, 3800),
    color: COLOUR,
    footer: { text: "Full reasoning: use the 🔍 Why? menu on any post · Powered by Hawk 🦅" },
  };
}
