// Football data from football-data.org (free tier).

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

interface Match {
  utcDate: string;
  status: string;
  matchday: number | null;
  stage: string;
  homeTeam: { shortName?: string; name: string };
  awayTeam: { shortName?: string; name: string };
}

const ymd = (d: Date) => d.toISOString().slice(0, 10);
const team = (t: { shortName?: string; name: string }) => t.shortName || t.name;

// Fetch with a 10-minute cache, so repeat commands don't use up the 10-requests-a-minute limit.
async function getJson(url: string, token: string): Promise<any> {
  const cache = (globalThis as any).caches?.default as Cache | undefined;
  const key = new Request(url);
  const hit = cache ? await cache.match(key) : undefined;
  if (hit) return hit.json();

  const res = await fetch(url, { headers: { "X-Auth-Token": token } });
  if (res.status === 400 || res.status === 401) throw new Error("Hawk's football data key was rejected – check the FOOTBALL_DATA_TOKEN secret.");
  if (res.status === 429) throw new Error("Football data is busy – try again in a minute.");
  if (res.status === 403) throw new Error("That competition isn't included in the free football data plan.");
  if (!res.ok) throw new Error(`Football data returned an error (${res.status}).`);

  const text = await res.text();
  if (cache) {
    await cache.put(key, new Response(text, { headers: { "Cache-Control": "max-age=600", "Content-Type": "application/json" } }));
  }
  return JSON.parse(text);
}

// Builds a fixtures embed for one competition, grouped by day.
// /fixtures uses the next 7 days; the daily post uses the next 24 hours and
// returns null when nothing is on, so empty channels don't get a post.
export async function fixturesEmbed(code: string, token: string, now = new Date(), hours = 168) {
  const league = LEAGUES[code];
  if (!league) throw new Error("Unknown competition.");

  const to = new Date(now.getTime() + hours * 3600 * 1000);
  const data = await getJson(
    `${API}/competitions/${code}/matches?dateFrom=${ymd(now)}&dateTo=${ymd(to)}`,
    token,
  );

  const upcoming: Match[] = (data.matches ?? []).filter((m: Match) => {
    const kickOff = new Date(m.utcDate);
    return ["SCHEDULED", "TIMED", "POSTPONED"].includes(m.status) && kickOff > now && kickOff <= to;
  });

  const daily = hours <= 24;
  const title = daily ? `${league.emoji} ${league.name} – today's fixtures` : `${league.emoji} ${league.name} – next 7 days`;
  if (upcoming.length === 0) {
    if (daily) return null;
    return { title, description: "No fixtures in the next 7 days.", color: COLOUR };
  }

  // Group by day (Irish time) and show kick-offs as Discord timestamps,
  // which display in each viewer's own time zone.
  const days = new Map<string, string[]>();
  for (const m of upcoming) {
    const day = new Date(m.utcDate).toLocaleDateString("en-IE", {
      weekday: "long", day: "numeric", month: "long", timeZone: "Europe/Dublin",
    });
    const unix = Math.floor(new Date(m.utcDate).getTime() / 1000);
    const time = m.status === "POSTPONED" ? "**Postponed**" : `<t:${unix}:t>`;
    const line = `${time} · ${team(m.homeTeam)} v ${team(m.awayTeam)}`;
    if (!days.has(day)) days.set(day, []);
    days.get(day)!.push(line);
  }

  let description = "";
  for (const [day, lines] of days) {
    const block = `**${day}**\n${lines.join("\n")}\n\n`;
    if (description.length + block.length > 3900) {
      description += "_…more fixtures not shown_";
      break;
    }
    description += block;
  }

  return {
    title,
    description: description.trim(),
    color: COLOUR,
    footer: { text: "Kick-off times shown in your time zone · Data: football-data.org" },
  };
}
