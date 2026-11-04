import { angleDiff, bearingBetween, pointAt } from '../core/geo';
import type { LngLat, Maneuver, ManeuverType } from '../types';

/**
 * Yandex's JS API returns route geometry and step boundaries but no instructions,
 * so maneuvers are reconstructed from the shape of the route:
 *  • with steps: every step boundary is a candidate; its turn angle is measured
 *    from the road bearing 30 m before vs 30 m after the boundary;
 *  • without steps: sharp, concentrated bends in the geometry are detected
 *    (wide-window angle large AND most of it happens within ±12 m — that separates
 *    junction turns from sweeping curves on mountain roads).
 */
export function deriveManeuvers(
  coords: LngLat[], cum: number[], stepStarts: number[], waypoints: { at: number; label: string }[],
): Maneuver[] {
  const total = cum[cum.length - 1];
  const out: Maneuver[] = [{ type: 'depart', angle: 0, at: 0, coord: coords[0] }];
  let candidates = stepStarts.filter((d) => d > 25 && d < total - 20);
  const geometric = candidates.length === 0;
  if (geometric) candidates = detectTurns(coords, cum);

  for (const d of candidates) {
    const a = turnAngle(coords, cum, d, 30);
    const type = classify(a, geometric ? 38 : 24);
    if (!type) continue;
    const last = out[out.length - 1];
    if (last.type !== 'depart' && d - last.at < 30) {
      if (Math.abs(a) > Math.abs(last.angle)) Object.assign(last, { type, angle: a, at: d, coord: pointAt(coords, cum, d).coord });
      continue;
    }
    out.push({ type, angle: a, at: d, coord: pointAt(coords, cum, d).coord });
  }
  for (const w of waypoints) out.push({ type: 'waypoint', angle: 0, at: w.at, coord: pointAt(coords, cum, w.at).coord, label: w.label });
  out.sort((a, b) => a.at - b.at);
  out.push({ type: 'arrive', angle: 0, at: total, coord: coords[coords.length - 1] });
  return out;
}

function turnAngle(coords: LngLat[], cum: number[], d: number, win: number): number {
  const total = cum[cum.length - 1];
  const inB = bearingBetween(coords, cum, Math.max(0, d - win), Math.max(0, d - 2));
  const outB = bearingBetween(coords, cum, Math.min(total, d + 2), Math.min(total, d + win));
  return angleDiff(inB, outB);
}

function classify(a: number, min: number): ManeuverType | null {
  const m = Math.abs(a);
  if (m < min) return null;
  const side = a > 0 ? 'right' : 'left';
  if (m < 45) return `slight-${side}` as ManeuverType;
  if (m < 125) return side as ManeuverType;
  if (m < 165) return `sharp-${side}` as ManeuverType;
  return 'uturn';
}

function detectTurns(coords: LngLat[], cum: number[]): number[] {
  const total = cum[cum.length - 1];
  const raw: { d: number; a: number }[] = [];
  for (let i = 1; i < coords.length - 1; i++) {
    const d = cum[i];
    if (d < 25 || d > total - 20) continue;
    const wide = turnAngle(coords, cum, d, 28);
    if (Math.abs(wide) < 38) continue;
    const narrow = turnAngle(coords, cum, d, 12);
    if (Math.abs(narrow) < Math.abs(wide) * 0.55) continue;
    raw.push({ d, a: wide });
  }
  // non-maximum suppression within 45 m
  const kept: { d: number; a: number }[] = [];
  for (const r of raw) {
    const last = kept[kept.length - 1];
    if (last && r.d - last.d < 45) {
      if (Math.abs(r.a) > Math.abs(last.a)) kept[kept.length - 1] = r;
    } else kept.push(r);
  }
  return kept.map((k) => k.d);
}
