// Corners and cards for live predictions: ratings from the football-data.co.uk history
// (refreshed Tuesday and Friday nights), and grading from the same files once a game's
// stats arrive. Not available for the Champions League (no history file).

import { buildCountRatings, expectedCounts, setPieceLegs, gradeSetPiece, type CountRatings, type CountGame, type SetPieceSpec } from "./setpieces";
import { seasonCode, type HistoryRow } from "./csv";
import { DIVISIONS } from "./history";
import type { Leg } from "./model";

export interface SetPieceRatings { corners: CountRatings; cards: CountRatings; refsKnown: boolean }

// "Michael Oliver", "M Oliver" and "Oliver M" all become "m oliver".
export function refKey(name?: string | null): string | undefined {
  if (!name) return undefined;
  const parts = name.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z ]/g, " ").split(/\s+/).filter(Boolean);
  if (parts.length < 2) return parts[0];
  const [first, last] = parts[parts.length - 1].length === 1 ? [parts[parts.length - 1], parts[0]] : [parts[0], parts[parts.length - 1]];
  return `${first[0]} ${last}`;
}

async function historyRows(kv: KVNamespace, code: string, now: Date) {
  const [map, a, b] = await Promise.all([
    kv.get<Record<string, number>>(`teammap:${code}`, "json"),
    kv.get<HistoryRow[]>(`history:${code}:${seasonCode(now, 1)}`, "json"),
    kv.get<HistoryRow[]>(`history:${code}:${seasonCode(now, 0)}`, "json"),
  ]);
  return { map: map ?? {}, rows: [...(a ?? []), ...(b ?? [])] };
}

export async function loadSetPieceRatings(kv: KVNamespace | undefined, code: string, now: Date): Promise<SetPieceRatings | null> {
  if (!kv || !DIVISIONS[code]) return null;
  const { map, rows } = await historyRows(kv, code, now);
  const corners: CountGame[] = [], cards: CountGame[] = [];
  for (const r of rows) {
    const h = map[r[1]], a = map[r[2]];
    if (!h || !a) continue;
    if (r[5] != null && r[6] != null) corners.push({ date: r[0], home: h, away: a, hv: r[5], av: r[6] });
    if (r[7] != null && r[8] != null) cards.push({ date: r[0], home: h, away: a, hv: r[7] + (r[9] ?? 0), av: r[8] + (r[10] ?? 0), ref: refKey(r[11]) });
  }
  if (corners.length < 60 || cards.length < 60) return null;
  const k = buildCountRatings(cards, now, true);
  return { corners: buildCountRatings(corners, now), cards: k, refsKnown: k.refs.size > 0 };
}

export interface SetPiecePrediction {
  corners: { home: number; away: number };
  cards: { home: number; away: number };
  ref?: { name: string; x: number };
  legs: Leg[];
}

export function predictSetPieces(r: SetPieceRatings, homeId: number, awayId: number, homeName: string, awayName: string, refName?: string): SetPiecePrediction {
  const key = refKey(refName);
  const refX = key ? r.cards.refs.get(key) : undefined;
  const corners = expectedCounts(r.corners, homeId, awayId);
  const cards = expectedCounts(r.cards, homeId, awayId, refX !== undefined ? key : undefined);
  const legs = setPieceLegs(corners, r.corners.spread, cards, r.cards.spread, homeName, awayName)
    .map((l) => ({ label: l.label, family: l.family, spec: l.spec, p: l.p } as Leg));
  return { corners, cards, ref: refName && refX !== undefined ? { name: refName, x: refX } : undefined, legs };
}

// The referee for a fixture, if the free data names one.
export const refereeOf = (m: any): string | undefined =>
  (m.referees ?? []).find((x: any) => !x.type || x.type === "REFEREE")?.name;

// A finished game's corners and cards, once the history files have it.
export async function matchStats(kv: KVNamespace | undefined, code: string, kickOff: string, homeId: number, awayId: number) {
  if (!kv || !DIVISIONS[code]) return null;
  const { map, rows } = await historyRows(kv, code, new Date(kickOff));
  const day = Date.parse(kickOff.slice(0, 10));
  const r = rows.find((x) => map[x[1]] === homeId && map[x[2]] === awayId && Math.abs(Date.parse(x[0]) - day) <= 864e5);
  if (!r || r[5] == null || r[6] == null || r[7] == null || r[8] == null) return null;
  return { hc: r[5], ac: r[6], hk: r[7] + (r[9] ?? 0), ak: r[8] + (r[10] ?? 0) };
}

export const gradeWithStats = (spec: SetPieceSpec, s: { hc: number; ac: number; hk: number; ak: number }) => gradeSetPiece(spec, s.hc, s.ac, s.hk, s.ak);
