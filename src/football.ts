// Football data from football-data.org (free tier): fixtures, form and league tables.

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
const COLOUR = 0xf2a900;
const FORM_DAYS = 70; // how far back to look for recent results (covers international breaks)
const DOT = { W: "🟢", D: "🟡", L: "🔴" } as const;
type Result = keyof typeof DOT;

interface Team { id: number; name: string; shortName?: string; tla?: string }
interface Match {
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
const ymd = (d: Date) => d.toISOString().slice(0, 10);
const teamName = (t: Team) => t.shortName || t.name;
const league = (code: string) => {
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

// One request gets both recent results (for form) and upcoming fixtures.
async function getMatches(code: string, token: string, now: Date, daysAhead: number): Promise<Match[]> {
  const from = new Date(now.getTime() - FORM_DAYS * DAY);
  const to = new Date(now.getTime() + daysAhead * DAY);
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
  return matches
    .filter((m) => m.status === "FINISHED" && new Date(m.utcDate) < before && (m.homeTeam.id === teamId || m.awayTeam.id === teamId))
    .sort((a, b) => a.utcDate.localeCompare(b.utcDate))
    .slice(-5)
    .map((m) => {
      const w = m.score?.winner;
      if (w === "DRAW" || !w) return "D";
      const home = m.homeTeam.id === teamId;
      return (w === "HOME_TEAM") === home ? "W" : "L";
    });
}

const dots = (form: Result[]) => (form.length ? form.map((r) => DOT[r]).join("") : "–");

function fitLines(blocks: string[], limit = 3900, more = "_…more not shown_"): string {
  let out = "";
  for (const b of blocks) {
    if (out.length + b.length > limit) return out + more;
    out += b;
  }
  return out.trim();
}

// ---------------------------------------------------------------------------
// Fixtures: /fixtures uses the next 7 days; the daily post uses the next 24 hours
// and returns null when nothing is on, so empty channels don't get a post.
// ---------------------------------------------------------------------------
export async function fixturesEmbed(code: string, token: string, now = new Date(), hours = 168) {
  const l = league(code);
  const to = new Date(now.getTime() + hours * 3600 * 1000);
  const matches = await getMatches(code, token, now, Math.ceil(hours / 24));

  const upcoming = matches.filter((m) => {
    const kickOff = new Date(m.utcDate);
    return ["SCHEDULED", "TIMED", "POSTPONED"].includes(m.status) && kickOff > now && kickOff <= to;
  });

  const daily = hours <= 24;
  const title = `${l.emoji} ${l.name} – ${daily ? "today's fixtures" : "next 7 days"}`;
  if (upcoming.length === 0) {
    if (daily) return null;
    return { title, description: "No fixtures in the next 7 days.", color: COLOUR };
  }

  const days = new Map<string, string[]>();
  for (const m of upcoming) {
    const kickOff = new Date(m.utcDate);
    const day = kickOff.toLocaleDateString("en-IE", { weekday: "long", day: "numeric", month: "long", timeZone: "Europe/Dublin" });
    const time = m.status === "POSTPONED" ? "**Postponed**" : `<t:${Math.floor(kickOff.getTime() / 1000)}:t>`;
    const homeForm = dots(formFor(m.homeTeam.id, matches, kickOff));
    const awayForm = dots(formFor(m.awayTeam.id, matches, kickOff));
    const line = `${time} · **${teamName(m.homeTeam)}** v **${teamName(m.awayTeam)}**\n　${homeForm}  v  ${awayForm}`;
    if (!days.has(day)) days.set(day, []);
    days.get(day)!.push(line);
  }

  return {
    title,
    description: fitLines([...days].map(([day, lines]) => `**${day}**\n${lines.join("\n")}\n\n`), 3900, "_…more fixtures not shown_"),
    color: COLOUR,
    footer: { text: "Form: last 5 in this competition, latest on the right · Times in your time zone · Data: football-data.org" },
  };
}

// ---------------------------------------------------------------------------
// /table
// ---------------------------------------------------------------------------
export async function tableEmbed(code: string, token: string, now = new Date()) {
  const l = league(code);
  const [{ total }, matches] = await Promise.all([getStandings(code, token), getMatches(code, token, now, 0)]);
  if (total.length === 0) return { title: `${l.emoji} ${l.name} – table`, description: "No table available yet.", color: COLOUR };

  const lines = total.map((r) => {
    const gd = r.goalDifference > 0 ? `+${r.goalDifference}` : `${r.goalDifference}`;
    return `\`${String(r.position).padStart(2)}\` **${teamName(r.team)}** · ${r.points} pts · ${r.playedGames} pl · GD ${gd}　${dots(formFor(r.team.id, matches, now))}\n`;
  });

  return {
    title: `${l.emoji} ${l.name} – table`,
    description: fitLines(lines),
    color: COLOUR,
    footer: { text: "Form: last 5 in this competition, latest on the right · Data: football-data.org" },
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
    footer: { text: `${l.name} only · Data: football-data.org` },
  };
}
