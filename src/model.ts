// Hawk's football model.
//
// 1. Rate every team's attack and defence from recent goals, adjusted for who they played
//    and where, with recent games counting more. Early in the season ratings are pulled
//    towards average, so a couple of freak results don't dominate.
// 2. Turn the ratings into expected goals for each side.
// 3. Build a probability for every scoreline (Poisson, with the Dixon-Coles tweak that
//    makes low-scoring draws more realistic).
// 4. Read every market – and every bet builder – straight off that scoreline grid, so
//    legs that go hand in hand are priced together properly.

export interface Team { id: number; name: string; shortName?: string }
export interface Match {
  utcDate: string;
  status: string;
  homeTeam: Team;
  awayTeam: Team;
  score?: { fullTime?: { home: number | null; away: number | null } };
}

const DAY = 864e5;
const HALF_LIFE_DAYS = 90; // a game 90 days ago counts half as much as one today
const PRIOR_GAMES = 4; // how strongly ratings are pulled to average early on
const RHO = -0.1; // Dixon-Coles low-score adjustment
const MAX_GOALS = 8; // 9+ goals for one side is too rare to matter

export interface Ratings {
  avgHome: number;
  avgAway: number;
  attack: Map<number, number>;
  defence: Map<number, number>;
  games: Map<number, number>;
}

export function buildRatings(matches: Match[], now: Date): Ratings {
  const played = matches
    .filter((m) => m.status === "FINISHED" && m.score?.fullTime?.home != null && new Date(m.utcDate) < now)
    .map((m) => ({
      h: m.homeTeam.id,
      a: m.awayTeam.id,
      hg: m.score!.fullTime!.home as number,
      ag: m.score!.fullTime!.away as number,
      w: Math.pow(0.5, (now.getTime() - new Date(m.utcDate).getTime()) / DAY / HALF_LIFE_DAYS),
    }));

  let wSum = 0, hSum = 0, aSum = 0;
  for (const g of played) { wSum += g.w; hSum += g.w * g.hg; aSum += g.w * g.ag; }
  // Typical European league figures until there's enough data of our own.
  const avgHome = wSum > 5 ? hSum / wSum : 1.5;
  const avgAway = wSum > 5 ? aSum / wSum : 1.2;
  const avgGoal = (avgHome + avgAway) / 2;

  const attack = new Map<number, number>();
  const defence = new Map<number, number>();
  const games = new Map<number, number>();
  const get = (m: Map<number, number>, id: number) => m.get(id) ?? 1;
  for (const g of played) {
    games.set(g.h, (games.get(g.h) ?? 0) + 1);
    games.set(g.a, (games.get(g.a) ?? 0) + 1);
  }

  // A few passes so each rating accounts for the strength of the opponents faced.
  for (let pass = 0; pass < 4; pass++) {
    const scored = new Map<number, number>(), expScored = new Map<number, number>();
    const conceded = new Map<number, number>(), expConceded = new Map<number, number>();
    const add = (m: Map<number, number>, id: number, v: number) => m.set(id, (m.get(id) ?? 0) + v);
    for (const g of played) {
      add(scored, g.h, g.w * g.hg);
      add(expScored, g.h, g.w * avgHome * get(defence, g.a));
      add(conceded, g.h, g.w * g.ag);
      add(expConceded, g.h, g.w * avgAway * get(attack, g.a));
      add(scored, g.a, g.w * g.ag);
      add(expScored, g.a, g.w * avgAway * get(defence, g.h));
      add(conceded, g.a, g.w * g.hg);
      add(expConceded, g.a, g.w * avgHome * get(attack, g.h));
    }
    const prior = PRIOR_GAMES * avgGoal;
    for (const id of games.keys()) {
      attack.set(id, ((scored.get(id) ?? 0) + prior) / ((expScored.get(id) ?? 0) + prior));
      defence.set(id, ((conceded.get(id) ?? 0) + prior) / ((expConceded.get(id) ?? 0) + prior));
    }
  }
  return { avgHome, avgAway, attack, defence, games };
}

export function expectedGoals(r: Ratings, homeId: number, awayId: number) {
  const att = (id: number) => r.attack.get(id) ?? 1;
  const def = (id: number) => r.defence.get(id) ?? 1;
  return {
    home: r.avgHome * att(homeId) * def(awayId),
    away: r.avgAway * att(awayId) * def(homeId),
  };
}

function poisson(k: number, lambda: number): number {
  let p = Math.exp(-lambda);
  for (let i = 1; i <= k; i++) p *= lambda / i;
  return p;
}

// grid[h][a] = chance the match finishes h-a
export function scoreGrid(lh: number, la: number): number[][] {
  const grid: number[][] = [];
  let total = 0;
  for (let h = 0; h <= MAX_GOALS; h++) {
    grid.push([]);
    for (let a = 0; a <= MAX_GOALS; a++) {
      let tau = 1;
      if (h === 0 && a === 0) tau = 1 - lh * la * RHO;
      else if (h === 0 && a === 1) tau = 1 + lh * RHO;
      else if (h === 1 && a === 0) tau = 1 + la * RHO;
      else if (h === 1 && a === 1) tau = 1 - RHO;
      const p = Math.max(0, tau) * poisson(h, lh) * poisson(a, la);
      grid[h].push(p);
      total += p;
    }
  }
  return grid.map((row) => row.map((p) => p / total));
}

type Test = (h: number, a: number) => boolean;
export const chance = (grid: number[][], ...tests: Test[]) => {
  let p = 0;
  grid.forEach((row, h) => row.forEach((v, a) => { if (tests.every((t) => t(h, a))) p += v; }));
  return p;
};

export interface Leg { label: string; family: string; test: Test; p: number; mask: Uint8Array }

// Which scorelines each leg wins on, worked out once so builders are quick to price.
const cells = (grid: number[][]) => grid.flat();
function maskFor(grid: number[][], test: Test): Uint8Array {
  const m = new Uint8Array(grid.length * grid[0].length);
  let i = 0;
  grid.forEach((row, h) => row.forEach((_v, a) => { m[i++] = test(h, a) ? 1 : 0; }));
  return m;
}
function jointChance(flat: number[], masks: Uint8Array[]): number {
  let p = 0;
  outer: for (let i = 0; i < flat.length; i++) {
    for (const m of masks) if (!m[i]) continue outer;
    p += flat[i];
  }
  return p;
}

// Every leg Hawk can price from the scoreline grid. One leg per family in a builder.
export function allLegs(grid: number[][], home: string, away: string): Leg[] {
  const legs: Omit<Leg, "p">[] = [
    { label: `${home} win`, family: "result", test: (h, a) => h > a },
    { label: `${away} win`, family: "result", test: (h, a) => a > h },
    { label: "Draw", family: "result", test: (h, a) => h === a },
    { label: `${home} or draw`, family: "result", test: (h, a) => h >= a },
    { label: `${away} or draw`, family: "result", test: (h, a) => a >= h },
    ...[1.5, 2.5, 3.5].map((x) => ({ label: `Over ${x} goals`, family: "goals", test: (h: number, a: number) => h + a > x })),
    ...[1.5, 2.5, 3.5].map((x) => ({ label: `Under ${x} goals`, family: "goals", test: (h: number, a: number) => h + a < x })),
    { label: "Both teams to score", family: "btts", test: (h, a) => h > 0 && a > 0 },
    { label: "Both teams to score – No", family: "btts", test: (h, a) => h === 0 || a === 0 },
    { label: `${home} to score`, family: "home-goals", test: (h) => h > 0 },
    { label: `${home} 2+ goals`, family: "home-goals", test: (h) => h >= 2 },
    { label: `${away} clean sheet`, family: "home-goals", test: (h) => h === 0 },
    { label: `${away} to score`, family: "away-goals", test: (_h, a) => a > 0 },
    { label: `${away} 2+ goals`, family: "away-goals", test: (_h, a) => a >= 2 },
    { label: `${home} clean sheet`, family: "away-goals", test: (_h, a) => a === 0 },
  ];
  const flat = cells(grid);
  return legs.map((l) => {
    const mask = maskFor(grid, l.test);
    return { ...l, mask, p: jointChance(flat, [mask]) };
  });
}

export interface Builder { legs: Leg[]; p: number }

// Hawk's bet builder: the most likely 3-leg combo (or 2 if no 3 works), where
// - it's built around the match result (a win or double chance), like a real builder
// - every leg is a genuine pick (55–90% on its own – near-certainties add nothing)
// - no leg is already implied by the others (each must add real risk)
// - the whole thing lands at least 40% of the time.
export function bestBuilder(grid: number[][], legs: Leg[]): Builder | null {
  const pool = legs.filter((l) => l.p >= 0.55 && l.p < 0.9);
  const flat = cells(grid);
  let best: Builder | null = null;

  const consider = (combo: Leg[]) => {
    if (new Set(combo.map((l) => l.family)).size !== combo.length) return;
    if (!combo.some((l) => l.family === "result")) return;
    const p = jointChance(flat, combo.map((l) => l.mask));
    if (p < 0.4) return;
    for (let i = 0; i < combo.length; i++) {
      const without = jointChance(flat, combo.filter((_, j) => j !== i).map((l) => l.mask));
      if (without - p < 0.04) return; // this leg barely changes anything – it's implied
    }
    const better = !best || combo.length > best.legs.length || (combo.length === best.legs.length && p > best.p);
    if (better) best = { legs: combo, p };
  };

  for (let i = 0; i < pool.length; i++)
    for (let j = i + 1; j < pool.length; j++) {
      consider([pool[i], pool[j]]);
      for (let k = j + 1; k < pool.length; k++) consider([pool[i], pool[j], pool[k]]);
    }
  return best;
}

export interface Prediction {
  xgHome: number;
  xgAway: number;
  home: number;
  draw: number;
  away: number;
  likely: { h: number; a: number; p: number };
  legs: Leg[];
  builder: Builder | null;
  grid: number[][];
  dataGames: number; // fewest games either side has been rated on
}

export function predict(r: Ratings, homeTeam: Team, awayTeam: Team, homeName: string, awayName: string): Prediction {
  const xg = expectedGoals(r, homeTeam.id, awayTeam.id);
  const grid = scoreGrid(xg.home, xg.away);
  let likely = { h: 0, a: 0, p: 0 };
  grid.forEach((row, h) => row.forEach((p, a) => { if (p > likely.p) likely = { h, a, p }; }));
  const legs = allLegs(grid, homeName, awayName);
  return {
    xgHome: xg.home,
    xgAway: xg.away,
    home: chance(grid, (h, a) => h > a),
    draw: chance(grid, (h, a) => h === a),
    away: chance(grid, (h, a) => a > h),
    likely,
    legs,
    builder: bestBuilder(grid, legs),
    grid,
    dataGames: Math.min(r.games.get(homeTeam.id) ?? 0, r.games.get(awayTeam.id) ?? 0),
  };
}

// ✅ 70%+ strong · 🟡 55–69% only at decent odds · ❌ under 55% skip
export const light = (p: number) => (p >= 0.7 ? "✅" : p >= 0.55 ? "🟡" : "❌");
export const pct = (p: number) => `${Math.round(p * 100)}%`;
// The usual UK fractional prices, shortest first.
const LADDER: [number, number][] = [
  [1, 10], [1, 9], [1, 8], [1, 7], [2, 13], [1, 6], [2, 11], [1, 5], [2, 9], [1, 4], [2, 7], [3, 10], [1, 3], [4, 11],
  [2, 5], [4, 9], [1, 2], [8, 15], [4, 7], [8, 13], [4, 6], [8, 11], [4, 5], [5, 6], [10, 11], [1, 1], [21, 20],
  [11, 10], [6, 5], [5, 4], [11, 8], [6, 4], [13, 8], [7, 4], [15, 8], [2, 1], [85, 40], [9, 4], [5, 2], [11, 4],
  [3, 1], [10, 3], [7, 2], [4, 1], [9, 2], [5, 1], [11, 2], [6, 1], [13, 2], [7, 1], [15, 2], [8, 1], [9, 1],
  [10, 1], [11, 1], [12, 1], [14, 1], [16, 1], [20, 1], [25, 1], [33, 1], [40, 1], [50, 1], [66, 1], [100, 1],
];

// Break-even price as a fraction, e.g. 50% → "Evens", 33% → "2/1".
// Rounded UP to the next standard price, so taking that price or bigger is always worth it.
export const fairOdds = (p: number) => {
  const need = 1 / p - 1;
  const hit = LADDER.find(([a, b]) => a / b >= need - 1e-9) ?? LADDER[LADDER.length - 1];
  return hit[0] === hit[1] ? "Evens" : `${hit[0]}/${hit[1]}`;
};
