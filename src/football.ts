// Football data from football-data.org (free tier): fixtures, form, tables and predictions.

import { buildRatings, predict, light, pct, fairOdds, type Prediction } from "./model";

export const LEAGUES: Record<string, { name: string; emoji: string }> = {
  PL: { name: "Premier League", emoji: "🏴󠁧󠁢󠁥󠁮󠁧󠁿" },
  ELC: { name: "Championship", emoji: "🏴󠁧󠁢󠁥󠁮󠁧󠁿" },
  PD: { name: "La Liga", emoji: "🇪🇸" },
  SA: { name: "Serie A", emoji: "🇮🇹" },
  BL1: { name: "Bundesliga", emoji: "🇩🇪" },
  FL1: { name: "Ligue 1", emoji: "🇫🇷" },
  CL: { name: "Champions League", emoji: "🇪🇺" },
  DED: { name: "Eredivisie", emoji: "🇳🇱" },
  PPL: { name: "Primeira Liga", emoji: "🇵🇹" },
};

const API = "https://api.football-data.org/v4";
export const COLOUR = 0xf2a900;
const HISTORY_DAYS = 120; // results used for form and ratings (older games barely count anyway)
const AHEAD_DAYS = 14; // fixtures fetched ahead
const DOT = { W: "🟢", D: "🟡", L: "🔴" } as const;
type Result = keyof typeof DOT;

export interface Team { id: number; name: string; shortName?: string; tla?: string }
export interface Match {
  utcDate: string;
  status: string;
  homeTeam: Team;
  awayTeam: Team;
  score?: { winner: "HOME_TEAM" | "AWAY_TEAM" | "DRAW" | null; fullTime?: { home: number | null; away: number | null } };
}
interface Row {
  position: number;
  team: Team;
  playedGames: number;
  won: number;
  draw: number;
  lost: number;
  points: number;
  goalsFor: number;
  goalsAgainst: number;
  goalDifference: number;
}

const DAY = 24 * 3600 * 1000;
const DAY_LABEL = new Intl.DateTimeFormat("en-IE", { weekday: "long", day: "numeric", month: "long", timeZone: "Europe/Dublin" });
const ymd = (d: Date) => d.toISOString().slice(0, 10);
export const teamName = (t: Team) => t.shortName || t.name;
export const league = (code: string) => {
  const l = LEAGUES[code];
  if (!l) throw new Error("Unknown competition.");
  return l;
};

// Fetch with a 10-minute cache, so repeat commands don't use up the 10-requests-a-minute limit.
async function getJson(url: string, token: string): Promise<any> {
  const cache = (globalThis as any).caches?.default as Cache | undefined;
  const key = new Request(url);
  const hit = cache ? await cache.match(key) : undefined;
  if (hit) return hit.json();

  const res = await fetch(url, { headers: { "X-Auth-Token": token } });
  const text = await res.text();
  if (!res.ok) {
    let detail = "";
    try { detail = JSON.parse(text).message ?? ""; } catch {}
    if (res.status === 400 && /token/i.test(detail)) throw new Error("Hawk's football data key was rejected – check the FOOTBALL_DATA_TOKEN secret.");
    if (res.status === 429) throw new Error("Football data is busy – try again in a minute.");
    if (res.status === 403) throw new Error("That competition isn't included in the free football data plan.");
    throw new Error(`Football data error ${res.status}${detail ? `: ${detail}` : ""}`);
  }

  if (cache) {
    await cache.put(key, new Response(text, { headers: { "Cache-Control": "max-age=600", "Content-Type": "application/json" } }));
  }
  return JSON.parse(text);
}

// One request gets recent results (for form and ratings) and upcoming fixtures.
// Every command uses the same window, so they share the cache.
export async function getMatches(code: string, token: string, now: Date): Promise<Match[]> {
  const from = new Date(now.getTime() - HISTORY_DAYS * DAY);
  const to = new Date(now.getTime() + AHEAD_DAYS * DAY);
  const data = await getJson(`${API}/competitions/${code}/matches?dateFrom=${ymd(from)}&dateTo=${ymd(to)}`, token);
  return data.matches ?? [];
}

async function getStandings(code: string, token: string) {
  const data = await getJson(`${API}/competitions/${code}/standings`, token);
  const tables: { type: string; table: Row[] }[] = data.standings ?? [];
  return { total: tables.find((s) => s.type === "TOTAL")?.table ?? [] };
}

// Every finished game this season – used by /form for the full home and away record.
async function getSeasonResults(code: string, token: string): Promise<Match[]> {
  const data = await getJson(`${API}/competitions/${code}/matches?status=FINISHED`, token);
  return data.matches ?? [];
}

// Home or away record worked out from the season's results.
export function venueRecord(teamId: number, matches: Match[], venue: "home" | "away"): string {
  let w = 0, d = 0, l = 0, gf = 0, ga = 0;
  for (const m of matches) {
    if (m.status !== "FINISHED") continue;
    const isHome = m.homeTeam.id === teamId;
    const isAway = m.awayTeam.id === teamId;
    if ((venue === "home" && !isHome) || (venue === "away" && !isAway)) continue;
    const ft = m.score?.fullTime;
    if (!ft || ft.home == null || ft.away == null) continue;
    const scored = isHome ? ft.home : ft.away;
    const conceded = isHome ? ft.away : ft.home;
    gf += scored; ga += conceded;
    if (scored > conceded) w++; else if (scored === conceded) d++; else l++;
  }
  if (w + d + l === 0) return "no games yet";
  return `W${w} D${d} L${l} · scored ${gf}, conceded ${ga}`;
}

// Last 5 results for a team, oldest first so the latest is on the right.
export function formFor(teamId: number, matches: Match[], before: Date): Result[] {
  const cutoff = before.toISOString().slice(0, 19); // compare as text – much faster than building dates
  return matches
    .filter((m) => m.status === "FINISHED" && (m.homeTeam.id === teamId || m.awayTeam.id === teamId) && m.utcDate.slice(0, 19) < cutoff)
    .sort((a, b) => a.utcDate.localeCompare(b.utcDate))
    .slice(-5)
    .map((m) => {
      const w = m.score?.winner;
      if (w === "DRAW" || !w) return "D";
      const home = m.homeTeam.id === teamId;
      return (w === "HOME_TEAM") === home ? "W" : "L";
    });
}

export const dots = (form: Result[]) => (form.length ? form.map((r) => DOT[r]).join("") : "–");

export function fitLines(blocks: string[], limit = 3900, more = "_…more not shown_"): string {
  let out = "";
  for (const b of blocks) {
    if (out.length + b.length > limit) return out + more;
    out += b;
  }
  return out.trim();
}

// ---------------------------------------------------------------------------
// Fixtures: /fixtures uses the next 7 days; the daily post uses the next 24 hours.
// One pass works out both the league post and the bet builders, so the data is
// only fetched and processed once.
// ---------------------------------------------------------------------------
export type Predicted = Prediction & { homeName: string; awayName: string };

export async function leagueDay(code: string, token: string, now = new Date(), hours = 168, builderChannelId?: string) {
  const builderLink = builderChannelId ? `<#${builderChannelId}>` : "#bet-builders";
  const l = league(code);
  const to = new Date(now.getTime() + hours * 3600 * 1000);
  const matches = await getMatches(code, token, now);

  const ratings = buildRatings(matches, now);
  const upcoming = matches.filter((m) => {
    const kickOff = new Date(m.utcDate);
    return ["SCHEDULED", "TIMED", "POSTPONED"].includes(m.status) && kickOff > now && kickOff <= to;
  });

  const daily = hours <= 24;
  const title = `${l.emoji} ${l.name} – ${daily ? "today's fixtures" : "next 7 days"}`;
  if (upcoming.length === 0) {
    const empty = { builders: null, builderCount: 0, predictions: [], matches, ratings, league: l };
    if (daily) return { fixtures: null, ...empty };
    return { fixtures: { title, description: "No fixtures in the next 7 days.", color: COLOUR }, ...empty };
  }

  const PREDICT_LIMIT = 12; // keeps each run inside Cloudflare's free processing allowance
  const predictions: { m: Match; p: Predicted }[] = [];
  const days = new Map<string, string[]>();
  for (const m of upcoming) {
    const kickOff = new Date(m.utcDate);
    const day = DAY_LABEL.format(kickOff);
    const time = m.status === "POSTPONED" ? "**Postponed**" : `<t:${Math.floor(kickOff.getTime() / 1000)}:t>`;
    const homeForm = dots(formFor(m.homeTeam.id, matches, kickOff));
    const awayForm = dots(formFor(m.awayTeam.id, matches, kickOff));
    let line = `${time} · **${teamName(m.homeTeam)}** v **${teamName(m.awayTeam)}**\n　${homeForm}  v  ${awayForm}`;
    if (m.status !== "POSTPONED" && predictions.length < PREDICT_LIMIT) {
      const p = predictMatch(ratings, m);
      predictions.push({ m, p });
      line += "\n" + predictionLine(p);
    }
    if (!days.has(day)) days.set(day, []);
    days.get(day)!.push(line);
  }

  const withBuilder = predictions.filter((x) => x.p.builder);
  const top = upcoming.length > PREDICT_LIMIT ? `_Predictions shown for the first ${PREDICT_LIMIT} games – use /predict for the rest._\n\n` : "";
  const pointer = withBuilder.length ? `\n\n🧩 **Bet builders for these games** → ${builderLink}` : "";
  const fixtures = {
    title,
    description: top + fitLines([...days].map(([day, lines]) => `**${day}**\n${lines.join("\n")}\n\n`), 3700, "_…more fixtures not shown_") + pointer,
    color: COLOUR,
    footer: { text: "Form: last 5, latest on the right · Times in your time zone · Powered by Hawk 🦅" },
  };

  return { fixtures, builders: buildersEmbed(l, withBuilder, daily), builderCount: withBuilder.length, predictions, matches, ratings, league: l };
}

// The #bet-builders post: one builder per match, most likely first.
function buildersEmbed(l: { name: string; emoji: string }, list: { m: Match; p: Predicted }[], daily: boolean) {
  if (list.length === 0) return null;
  const blocks = [...list]
    .sort((a, b) => b.p.builder!.p - a.p.builder!.p)
    .map(({ m, p }) => {
      const b = p.builder!;
      const kickOff = Math.floor(new Date(m.utcDate).getTime() / 1000);
      return [
        `**${p.homeName} v ${p.awayName}** · <t:${kickOff}:${daily ? "t" : "f"}>`,
        ...b.legs.map((x) => `• ${x.label} (${pct(x.p)})`),
        `Together **${pct(b.p)}** · worth it at **${fairOdds(b.p)}** or bigger\n\n`,
      ].join("\n");
    });
  return {
    title: `🧩 ${l.emoji} ${l.name} – ${daily ? "today's" : "this week's"} bet builders`,
    description: fitLines(blocks, 3800, "_…more builders not shown_"),
    color: COLOUR,
    footer: { text: "Most likely first · Priced as one bet, not leg by leg · Powered by Hawk 🦅" },
  };
}

// /fixtures – the league list only (builders live in #bet-builders).
export async function fixturesEmbed(code: string, token: string, now = new Date(), hours = 168, builderChannelId?: string) {
  return (await leagueDay(code, token, now, hours, builderChannelId)).fixtures;
}

// ---------------------------------------------------------------------------
// /table
// ---------------------------------------------------------------------------
export async function tableEmbed(code: string, token: string, now = new Date()) {
  const l = league(code);
  const [{ total }, matches] = await Promise.all([getStandings(code, token), getMatches(code, token, now)]);
  if (total.length === 0) return { title: `${l.emoji} ${l.name} – table`, description: "No table available yet.", color: COLOUR };

  const lines = total.map((r) => {
    const gd = r.goalDifference > 0 ? `+${r.goalDifference}` : `${r.goalDifference}`;
    return `\`${String(r.position).padStart(2)}\` **${teamName(r.team)}** · ${r.points} pts · ${r.playedGames} pl · GD ${gd}　${dots(formFor(r.team.id, matches, now))}\n`;
  });

  return {
    title: `${l.emoji} ${l.name} – table`,
    description: fitLines(lines),
    color: COLOUR,
    footer: { text: "Form: last 5 in this competition, latest on the right · Powered by Hawk 🦅" },
  };
}

// ---------------------------------------------------------------------------
// /form
// ---------------------------------------------------------------------------
const clean = (s: string) =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\b(fc|afc|cf|sc|ac|ssc)\b/g, "").replace(/[^a-z0-9]+/g, " ").trim();

// Nicknames people actually type, mapped to how the data names the team.
const NICKNAMES: Record<string, string> = {
  spurs: "tottenham", wolves: "wolverhampton", "man utd": "manchester united", "man u": "manchester united",
  utd: "manchester united", city: "manchester city", villa: "aston villa", palace: "crystal palace",
  forest: "nottingham", toon: "newcastle", hammers: "west ham", barca: "barcelona", atleti: "atletico",
  inter: "inter", juve: "juventus", psg: "paris saint germain", bayern: "bayern", bvb: "dortmund",
  gladbach: "monchengladbach", leverkusen: "leverkusen", baggies: "west bromwich", boro: "middlesbrough",
};

export function findTeam(query: string, rows: Row[]): { match?: Row; suggestions: Row[] } {
  const typed = clean(query);
  const q = NICKNAMES[typed] ?? typed;
  if (!q) return { suggestions: [] };
  const names = (r: Row) => [r.team.name, r.team.shortName ?? "", r.team.tla ?? ""].map(clean);
  const exact = rows.filter((r) => names(r).includes(q));
  if (exact.length === 1) return { match: exact[0], suggestions: [] };
  const partial = rows.filter((r) => names(r).some((n) => n.startsWith(q) || n.includes(` ${q}`) || n.includes(q)));
  if (partial.length === 1) return { match: partial[0], suggestions: [] };
  return { suggestions: (exact.length ? exact : partial).slice(0, 5) };
}

export async function formEmbed(code: string, query: string, token: string, now = new Date()) {
  const l = league(code);
  const [{ total }, matches] = await Promise.all([getStandings(code, token), getSeasonResults(code, token)]);

  const { match, suggestions } = findTeam(query, total);
  if (!match) {
    const hint = suggestions.length
      ? `Did you mean: ${suggestions.map((r) => `**${teamName(r.team)}**`).join(", ")}?`
      : `Check the spelling, or pick a different league – I looked in the ${l.name}.`;
    throw new Error(`Couldn't find "${query}". ${hint}`);
  }

  const t = match.team;

  const recent = matches
    .filter((m) => m.status === "FINISHED" && (m.homeTeam.id === t.id || m.awayTeam.id === t.id))
    .sort((a, b) => b.utcDate.localeCompare(a.utcDate))
    .slice(0, 5)
    .map((m) => {
      const isHome = m.homeTeam.id === t.id;
      const res = formFor(t.id, [m], new Date(now.getTime() + DAY))[0];
      const opp = teamName(isHome ? m.awayTeam : m.homeTeam);
      const ft = m.score?.fullTime;
      // Score from this team's point of view, e.g. a 1-0 away defeat shows as 0-1
      const score = ft && ft.home != null ? (isHome ? `${ft.home}-${ft.away}` : `${ft.away}-${ft.home}`) : "";
      return `${DOT[res]} ${isHome ? "v" : "@"} ${opp} ${score}`;
    });

  const gd = match.goalDifference > 0 ? `+${match.goalDifference}` : `${match.goalDifference}`;
  return {
    title: `${l.emoji} ${t.name} – form`,
    description: [
      `**Form:** ${dots(formFor(t.id, matches, now))}  _(latest on the right)_`,
      `**Position:** ${match.position} · ${match.points} pts from ${match.playedGames} · GD ${gd}`,
      "",
      `🏠 **Home:** ${venueRecord(t.id, matches, "home")}`,
      `✈️ **Away:** ${venueRecord(t.id, matches, "away")}`,
      "",
      `**Recent results** _(v = home, @ = away)_`,
      recent.length ? recent.join("\n") : "No results in the last few weeks.",
    ].join("\n"),
    color: COLOUR,
    footer: { text: `${l.name} only · Powered by Hawk 🦅` },
  };
}

// ---------------------------------------------------------------------------
// Predictions
// ---------------------------------------------------------------------------
export const predictMatch = (ratings: ReturnType<typeof buildRatings>, m: Match): Predicted => {
  const homeName = teamName(m.homeTeam), awayName = teamName(m.awayTeam);
  return { ...predict(ratings, m.homeTeam, m.awayTeam, homeName, awayName), homeName, awayName };
};

export const pickOf = (p: Predicted) => {
  const options = [
    { label: p.homeName, p: p.home },
    { label: "Draw", p: p.draw },
    { label: p.awayName, p: p.away },
  ];
  return options.reduce((a, b) => (b.p > a.p ? b : a));
};

// One compact line for fixture lists and the daily post.
function predictionLine(p: Predicted): string {
  const pick = pickOf(p);
  return `　🎯 ${p.homeName} ${pct(p.home)} · Draw ${pct(p.draw)} · ${p.awayName} ${pct(p.away)} → **${pick.label}** ${light(pick.p)} · ${p.likely.h}-${p.likely.a}`;
}

// /predict – the full card for a team's next match.
export async function predictEmbed(code: string, query: string, token: string, now = new Date()) {
  const l = league(code);
  const [{ total }, matches] = await Promise.all([getStandings(code, token), getMatches(code, token, now)]);
  const { match: row, suggestions } = findTeam(query, total.length ? total : teamsFrom(matches));
  if (!row) {
    const hint = suggestions.length ? `Did you mean: ${suggestions.map((r) => `**${teamName(r.team)}**`).join(", ")}?` : `I looked in the ${l.name}.`;
    throw new Error(`Couldn't find "${query}". ${hint}`);
  }
  const id = row.team.id;
  const next = matches
    .filter((m) => ["SCHEDULED", "TIMED"].includes(m.status) && new Date(m.utcDate) > now && (m.homeTeam.id === id || m.awayTeam.id === id))
    .sort((a, b) => a.utcDate.localeCompare(b.utcDate))[0];
  if (!next) throw new Error(`${teamName(row.team)} have no ${l.name} game in the next ${AHEAD_DAYS} days.`);

  const p = predictMatch(buildRatings(matches, now), next);
  const pick = pickOf(p);
  const leg = (label: string) => p.legs.find((x) => x.label === label)!;
  const show = (label: string) => { const x = leg(label); return `${x.label} **${pct(x.p)}** ${light(x.p)}`; };
  const kickOff = Math.floor(new Date(next.utcDate).getTime() / 1000);

  const fields = [
    {
      name: "🎯 Result",
      value: `🏠 ${p.homeName} **${pct(p.home)}** · 🤝 Draw **${pct(p.draw)}** · ✈️ ${p.awayName} **${pct(p.away)}**\nHawk's pick: **${pick.label}** ${light(pick.p)} – worth it at **${fairOdds(pick.p)}** or bigger`,
    },
    {
      name: "📊 Likely score",
      value: `**${p.likely.h}-${p.likely.a}** (${pct(p.likely.p)}) · expected goals ${p.xgHome.toFixed(1)} – ${p.xgAway.toFixed(1)}`,
    },
    {
      name: "⚽ Goals",
      value: [show("Over 1.5 goals"), show("Over 2.5 goals"), show("Under 3.5 goals"), show("Both teams to score"), show("Both teams to score – No")].join("\n"),
    },
    {
      name: "🛡️ Safer markets",
      value: [show(`${p.homeName} or draw`), show(`${p.awayName} or draw`), show(`${p.homeName} to score`), show(`${p.awayName} to score`)].join("\n"),
    },
    {
      name: "🧩 Hawk's bet builder",
      value: p.builder
        ? `${p.builder.legs.map((x) => `• ${x.label} (${pct(x.p)})`).join("\n")}\nTogether: **${pct(p.builder.p)}** – worth it at **${fairOdds(p.builder.p)}** or bigger\n_Priced as one bet, not leg by leg._`
        : "Nothing strong enough here – no builder lands 40%+ with real legs.",
    },
  ];

  const why = { homeId: next.homeTeam.id, awayId: next.awayTeam.id };
  const caution = p.dataGames < 6 ? "\n⚠️ _Early days – fewer than 6 games to rate these teams on, so treat with care._" : "";
  return {
    why,
    title: `🔮 ${p.homeName} v ${p.awayName}`,
    description: `${l.emoji} ${l.name} · <t:${kickOff}:F> (<t:${kickOff}:R>)${caution}`,
    color: COLOUR,
    fields,
    footer: { text: "Based on this season's goals only – no odds, injuries or team news yet · Powered by Hawk 🦅" },
  };
}

// Fallback team list for competitions without a table (e.g. knockout stages).
function teamsFrom(matches: Match[]): Row[] {
  const seen = new Map<number, Row>();
  for (const m of matches) for (const t of [m.homeTeam, m.awayTeam]) {
    if (t?.id && !seen.has(t.id)) seen.set(t.id, { position: 0, team: t, playedGames: 0, won: 0, draw: 0, lost: 0, points: 0, goalsFor: 0, goalsAgainst: 0, goalDifference: 0 });
  }
  return [...seen.values()];
}
