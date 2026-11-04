// Which league is a team in? Lets /predict and /form work without picking a league.
// Each league's 9am run saves its list of teams; anything missing is looked up on demand.

import { LEAGUES, getMatches, findTeam, type Match, type Team } from "./football";

const asRows = (teams: Team[]) => teams.map((team) => ({ position: 0, team, playedGames: 0, won: 0, draw: 0, lost: 0, points: 0, goalsFor: 0, goalsAgainst: 0, goalDifference: 0 }));

function teamsIn(matches: Match[]): Team[] {
  const seen = new Map<number, Team>();
  for (const m of matches) for (const t of [m.homeTeam, m.awayTeam]) if (t?.id && !seen.has(t.id)) seen.set(t.id, { id: t.id, name: t.name, shortName: t.shortName, tla: t.tla });
  return [...seen.values()];
}

export async function saveTeams(kv: KVNamespace | undefined, code: string, matches: Match[]) {
  if (kv) await kv.put(`teams:${code}`, JSON.stringify(teamsIn(matches)), { expirationTtl: 60 * 60 * 24 * 30 });
}

// "next" = the league of the team's next game (e.g. Champions League on a Tuesday);
// "domestic" = their own league, for /form.
export async function whichLeague(kv: KVNamespace | undefined, token: string, query: string, mode: "next" | "domestic", now = new Date()) {
  const codes = Object.keys(LEAGUES).filter((c) => mode === "next" || c !== "CL");
  const found: { code: string; id: number; name: string }[] = [];
  const missing: string[] = [];
  for (const code of codes) {
    const teams = kv ? await kv.get<Team[]>(`teams:${code}`, "json") : null;
    if (!teams) { missing.push(code); continue; }
    const hit = findTeam(query, asRows(teams) as any).match;
    if (hit) found.push({ code, id: hit.team.id, name: hit.team.name });
  }
  // Leagues we haven't listed yet – only looked up if the team wasn't found elsewhere.
  if (!found.length) {
    for (const code of missing) {
      const matches = await getMatches(code, token, now).catch(() => [] as Match[]);
      await saveTeams(kv, code, matches);
      const hit = findTeam(query, asRows(teamsIn(matches)) as any).match;
      if (hit) found.push({ code, id: hit.team.id, name: hit.team.name });
    }
  }
  if (!found.length) return null;
  if (mode === "domestic" || found.length === 1) return found[0].code;

  // In more than one competition: whichever game comes first.
  let best = found[0].code, bestTime = Infinity;
  for (const f of found) {
    const matches = await getMatches(f.code, token, now).catch(() => [] as Match[]);
    const next = matches
      .filter((m) => ["SCHEDULED", "TIMED"].includes(m.status) && new Date(m.utcDate) > now && (m.homeTeam.id === f.id || m.awayTeam.id === f.id))
      .map((m) => Date.parse(m.utcDate))
      .sort((a, b) => a - b)[0];
    if (next !== undefined && next < bestTime) { bestTime = next; best = f.code; }
  }
  return best;
}
