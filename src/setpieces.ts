// Corners and cards. Same idea as goals – each team gets a "for" and "against" rating, allowing
// for opponents and venue, recent games counting more – but corners and cards vary more from
// game to game than goals do, and more so in games where lots are expected. The model
// measures that extra variation from the data (a negative binomial) rather than assuming
// they behave like goals. Cards also allow for the referee.
//
// No imports, so the backtest on your PC can use it too.

export interface CountGame { date: string; home: string | number; away: string | number; hv: number; av: number; ref?: string }

const DAY = 864e5;
const HALF_LIFE_DAYS = 90;
const PRIOR_GAMES = 6;
const REF_PRIOR_GAMES = 8;
const MAX = 30;
const UNCERTAINTY = Number((globalThis as any).process?.env?.HAWK_UNCERTAINTY ?? 1); // tuned by the backtest

export interface CountRatings {
  avgHome: number;
  avgAway: number;
  forR: Map<string | number, number>;
  againstR: Map<string | number, number>;
  spread: number; // extra variation: 0 = like goals (Poisson); higher = more varied, especially in busy games
  refs: Map<string, number>; // referee multiplier (cards only)
}

export function buildCountRatings(games: CountGame[], now: Date, withRefs = false): CountRatings {
  const played = games
    .filter((g) => g.date < now.toISOString().slice(0, 10))
    .map((g) => ({ ...g, w: Math.pow(0.5, (now.getTime() - Date.parse(g.date)) / DAY / HALF_LIFE_DAYS) }));
  let W = 0, H = 0, A = 0;
  for (const g of played) { W += g.w; H += g.w * g.hv; A += g.w * g.av; }
  const avgHome = W > 5 ? H / W : 5, avgAway = W > 5 ? A / W : 4;
  const prior = PRIOR_GAMES * (avgHome + avgAway) / 2;
  const forR = new Map<string | number, number>(), againstR = new Map<string | number, number>();
  const get = (m: Map<string | number, number>, id: string | number) => m.get(id) ?? 1;
  const ids = new Set(played.flatMap((g) => [g.home, g.away]));

  for (let pass = 0; pass < 4; pass++) {
    const f = new Map<string | number, number>(), fe = new Map<string | number, number>(), a = new Map<string | number, number>(), ae = new Map<string | number, number>();
    const add = (m: Map<string | number, number>, id: string | number, v: number) => m.set(id, (m.get(id) ?? 0) + v);
    for (const g of played) {
      add(f, g.home, g.w * g.hv); add(fe, g.home, g.w * avgHome * get(againstR, g.away));
      add(a, g.home, g.w * g.av); add(ae, g.home, g.w * avgAway * get(forR, g.away));
      add(f, g.away, g.w * g.av); add(fe, g.away, g.w * avgAway * get(againstR, g.home));
      add(a, g.away, g.w * g.hv); add(ae, g.away, g.w * avgHome * get(forR, g.home));
    }
    for (const id of ids) {
      forR.set(id, ((f.get(id) ?? 0) + prior) / ((fe.get(id) ?? 0) + prior));
      againstR.set(id, ((a.get(id) ?? 0) + prior) / ((ae.get(id) ?? 0) + prior));
    }
  }

  // Referees: how many more (or fewer) cards than expected in their games
  const refs = new Map<string, number>();
  if (withRefs) {
    const seen = new Map<string, { obs: number; exp: number }>();
    for (const g of played) {
      if (!g.ref) continue;
      const exp = avgHome * get(forR, g.home) * get(againstR, g.away) + avgAway * get(forR, g.away) * get(againstR, g.home);
      const r = seen.get(g.ref) ?? { obs: 0, exp: 0 };
      r.obs += g.w * (g.hv + g.av); r.exp += g.w * exp;
      seen.set(g.ref, r);
    }
    const refPrior = REF_PRIOR_GAMES * (avgHome + avgAway);
    for (const [ref, r] of seen) refs.set(ref, (r.obs + refPrior) / (r.exp + refPrior));
  }

  // How varied are these counts, beyond what the ratings explain? (Measured, not assumed.)
  // Variance = mean + spread × mean², so busy games vary more.
  let extra = 0, sq = 0;
  for (const g of played) {
    for (const [obs, e] of [[g.hv, avgHome * get(forR, g.home) * get(againstR, g.away)], [g.av, avgAway * get(forR, g.away) * get(againstR, g.home)]]) {
      extra += g.w * ((obs - e) ** 2 - e); sq += g.w * e * e;
    }
  }
  // Plus the uncertainty in the ratings themselves – they're estimates from a limited number
  // of games, so predictions shouldn't treat them as exact. Fewer games = more uncertainty.
  const gamesPerTeam = ids.size ? (2 * W) / ids.size : 0;
  const ratingDoubt = UNCERTAINTY / (gamesPerTeam + PRIOR_GAMES);
  const spread = sq > 0 ? Math.min(1, Math.max(0, extra / sq) + ratingDoubt) : ratingDoubt;
  return { avgHome, avgAway, forR, againstR, spread, refs };
}

// Expected count for each side. `ref` only matters for cards.
export function expectedCounts(r: CountRatings, home: string | number, away: string | number, ref?: string) {
  const f = (id: string | number) => r.forR.get(id) ?? 1, a = (id: string | number) => r.againstR.get(id) ?? 1;
  const refX = ref ? (r.refs.get(ref) ?? 1) : 1;
  return { home: r.avgHome * f(home) * a(away) * refX, away: r.avgAway * f(away) * a(home) * refX };
}

// Chance of each count 0..MAX for one side – Poisson if there's no extra variation,
// otherwise negative binomial.
export function countDist(mean: number, spread: number): number[] {
  const out: number[] = [];
  if (spread <= 0.001) {
    let p = Math.exp(-mean);
    for (let k = 0; k <= MAX; k++) { out.push(p); p *= mean / (k + 1); }
  } else {
    const r = 1 / spread, q = r / (r + mean);
    let p = Math.pow(q, r);
    for (let k = 0; k <= MAX; k++) { out.push(p); p *= ((k + r) / (k + 1)) * (1 - q); }
  }
  const t = out.reduce((s, x) => s + x, 0);
  return out.map((x) => x / t);
}
export function totalDist(a: number[], b: number[]): number[] {
  const out = new Array(MAX + 1).fill(0);
  for (let i = 0; i <= MAX; i++) for (let j = 0; i + j <= MAX; j++) out[i + j] += a[i] * b[j];
  return out;
}
export const over = (d: number[], line: number) => d.reduce((s, p, k) => s + (k > line ? p : 0), 0);

export interface SetPieceSpec { t: "corners" | "cards"; side: "total" | "h" | "a"; op: ">" | "<"; x: number }
export interface SetPieceLeg { label: string; family: string; spec: SetPieceSpec; p: number }

// Every corners/cards market Hawk prices, for one game.
export function setPieceLegs(c: { home: number; away: number }, cs: number, k: { home: number; away: number }, ks: number, homeName: string, awayName: string): SetPieceLeg[] {
  const ch = countDist(c.home, cs), ca = countDist(c.away, cs), ct = totalDist(ch, ca);
  const kh = countDist(k.home, ks), ka = countDist(k.away, ks), kt = totalDist(kh, ka);
  const legs: SetPieceLeg[] = [];
  const both = (t: "corners" | "cards", side: "total" | "h" | "a", d: number[], lines: number[], name: string, family: string) => {
    for (const x of lines) {
      const o = over(d, x);
      legs.push({ label: `${name} over ${x}`, family, spec: { t, side, op: ">", x }, p: o });
      legs.push({ label: `${name} under ${x}`, family, spec: { t, side, op: "<", x }, p: 1 - o });
    }
  };
  both("corners", "total", ct, [7.5, 8.5, 9.5, 10.5, 11.5], "Corners", "corners");
  both("corners", "h", ch, [3.5, 4.5, 5.5], `${homeName} corners`, "home-corners");
  both("corners", "a", ca, [2.5, 3.5, 4.5], `${awayName} corners`, "away-corners");
  both("cards", "total", kt, [2.5, 3.5, 4.5, 5.5], "Cards", "cards");
  // Both teams carded = each side 1+ card (treated as independent of each other)
  legs.push({ label: "Both teams carded", family: "both-carded", spec: { t: "cards", side: "total", op: ">", x: -1 }, p: (1 - kh[0]) * (1 - ka[0]) });
  return legs;
}

export function gradeSetPiece(spec: SetPieceSpec, hc: number, ac: number, hk: number, ak: number): boolean {
  if (spec.t === "cards" && spec.x === -1) return hk > 0 && ak > 0; // both teams carded
  const [h, a] = spec.t === "corners" ? [hc, ac] : [hk, ak];
  const v = spec.side === "total" ? h + a : spec.side === "h" ? h : a;
  return spec.op === ">" ? v > spec.x : v < spec.x;
}
