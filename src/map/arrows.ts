/**
 * Painted lane arrows (the white arrows on the asphalt before a junction), drawn from one
 * definition both as map icons (canvas) and as lane-guidance glyphs in the turn banner (SVG).
 * Box: 40 × 80, pointing up (direction of travel).
 */

export type TurnDir = 'straight' | 'left' | 'right' | 'slight-left' | 'slight-right' | 'sharp-left' | 'sharp-right' | 'uturn' | 'merge-left' | 'merge-right';

const ORDER: TurnDir[] = ['uturn', 'sharp-left', 'left', 'slight-left', 'merge-left', 'straight', 'merge-right', 'slight-right', 'right', 'sharp-right'];

/** OSM `turn:lanes` values and Mapbox lane `indications` → one vocabulary. */
export function normalizeTurn(v: string): TurnDir | null {
  const s = v.trim().toLowerCase().replace(/[_ ]/g, '-');
  const map: Record<string, TurnDir> = {
    through: 'straight', straight: 'straight', left: 'left', right: 'right',
    'slight-left': 'slight-left', 'slight-right': 'slight-right', 'sharp-left': 'sharp-left', 'sharp-right': 'sharp-right',
    reverse: 'uturn', uturn: 'uturn', 'merge-to-left': 'merge-left', 'merge-to-right': 'merge-right',
  };
  return map[s] || null;
}

/** Canonical, de-duplicated list (left to right), e.g. ["left", "straight"]. */
export function turnSet(values: string[]): TurnDir[] {
  const set = new Set(values.map(normalizeTurn).filter(Boolean) as TurnDir[]);
  return ORDER.filter((d) => set.has(d));
}

const head = (x: number, y: number, deg: number) => {
  const a = (deg * Math.PI) / 180;
  const dx = Math.sin(a), dy = -Math.cos(a);
  const bx = x - 15 * dx, by = y - 15 * dy;
  const px = Math.cos(a) * 9.5, py = Math.sin(a) * 9.5;
  const f = (n: number) => n.toFixed(1);
  return `M${f(x)} ${f(y)}L${f(bx + px)} ${f(by + py)}L${f(bx - px)} ${f(by - py)}Z`;
};

const SHAPES: Record<TurnDir, { line: string; head: string }> = {
  straight: { line: 'M20 50L20 17', head: head(20, 2, 0) },
  right: { line: 'M20 56C20 40 21 33 25 33', head: head(39.5, 33, 90) },
  left: { line: 'M20 56C20 40 19 33 15 33', head: head(0.5, 33, 270) },
  'slight-right': { line: 'M20 54C20 42 22 36 25 30', head: head(33, 16, 32) },
  'slight-left': { line: 'M20 54C20 42 18 36 15 30', head: head(7, 16, 328) },
  'sharp-right': { line: 'M20 56C20 38 30 38 30 46', head: head(31, 61, 172) },
  'sharp-left': { line: 'M20 56C20 38 10 38 10 46', head: head(9, 61, 188) },
  uturn: { line: 'M22 52L22 26C22 13 7 13 7 26L7 37', head: head(7, 50, 180) },
  'merge-right': { line: 'M20 52L20 44C20 38 30 36 30 28', head: head(30, 15, 0) },
  'merge-left': { line: 'M20 52L20 44C20 38 10 36 10 28', head: head(10, 15, 0) },
};
const STEM = 'M20 78L20 50';

export function arrowParts(dirs: TurnDir[]): { lines: string[]; heads: string[] } {
  return { lines: [STEM, ...dirs.map((d) => SHAPES[d].line)], heads: dirs.map((d) => SHAPES[d].head) };
}

/** SVG markup for a lane glyph (banner). */
export function laneSvg(dirs: TurnDir[], color: string, size = 22): string {
  const { lines, heads } = arrowParts(dirs.length ? dirs : ['straight']);
  return `<svg viewBox="0 0 40 80" width="${size}" height="${size * 2}" aria-hidden="true">`
    + `<path d="${lines.join('')}" fill="none" stroke="${color}" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/>`
    + `<path d="${heads.join('')}" fill="${color}" stroke="${color}" stroke-width="2" stroke-linejoin="round"/></svg>`;
}

/** Map icon (ImageData at 2× for crisp edges) for `ta:left;straight`-style ids. */
export function arrowImage(dirs: TurnDir[], color: string): { width: number; height: number; data: Uint8ClampedArray } | null {
  if (typeof document === 'undefined' || !dirs.length) return null;
  const c = document.createElement('canvas');
  c.width = 80; c.height = 160;
  const ctx = c.getContext('2d');
  if (!ctx || typeof Path2D === 'undefined') return null;
  ctx.scale(2, 2);
  const { lines, heads } = arrowParts(dirs);
  ctx.strokeStyle = color; ctx.fillStyle = color;
  ctx.lineWidth = 6.5; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.stroke(new Path2D(lines.join('')));
  ctx.lineWidth = 2;
  const h = new Path2D(heads.join(''));
  ctx.fill(h); ctx.stroke(h);
  return { width: 80, height: 160, data: ctx.getImageData(0, 0, 80, 160).data };
}

/** Upright traffic-light icon (billboard), 2×: 26 × 60 logical. */
export function signalImage(): { width: number; height: number; data: Uint8ClampedArray } | null {
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = 52; c.height = 120;
  const ctx = c.getContext('2d');
  if (!ctx) return null;
  ctx.scale(2, 2);
  // pole
  ctx.fillStyle = '#2a2d33';
  ctx.fillRect(11.5, 36, 3, 24);
  // housing
  ctx.fillStyle = '#1c1f24';
  ctx.strokeStyle = 'rgba(255,255,255,.85)';
  ctx.lineWidth = 1.5;
  const r = 6, x = 3, y = 1, w = 20, hgt = 38;
  ctx.beginPath();
  ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + hgt - r); ctx.quadraticCurveTo(x + w, y + hgt, x + w - r, y + hgt);
  ctx.lineTo(x + r, y + hgt); ctx.quadraticCurveTo(x, y + hgt, x, y + hgt - r);
  ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.fill(); ctx.stroke();
  [['#ff453a', 9], ['#ffd60a', 20], ['#30d158', 31]].forEach(([col, cy]) => {
    ctx.fillStyle = col as string;
    ctx.beginPath(); ctx.arc(13, cy as number, 4.3, 0, Math.PI * 2); ctx.fill();
  });
  return { width: 52, height: 120, data: ctx.getImageData(0, 0, 52, 120).data };
}
