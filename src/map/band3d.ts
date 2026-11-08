import type { LngLat } from '../types';
import { withOrigin } from './mesh3d';

/**
 * The route band where the road is elevated (bridges, flyovers, ramps): a ribbon mesh drawn at the
 * deck's height as a MapLibre custom layer, since MapLibre's line layers can only lie on the ground.
 * Depth-tested against the decks, piers and buildings, with a faint second pass where it is hidden
 * (behind a pier, under a higher deck), so the route still reads — the Apple Maps "shows through the
 * pillars" effect. Ground-level stretches stay on the normal line layers.
 */

export interface BandRun { coords: LngLat[]; heights: number[]; width: number; color: [number, number, number] }

const VS = `
attribute vec3 aPos; attribute vec3 aCol;
uniform mat4 uMvp; varying vec3 vCol;
void main() { vCol = aCol; gl_Position = uMvp * vec4(aPos, 1.0); }`;
const FS = `
precision mediump float; varying vec3 vCol; uniform float uAlpha;
void main() { gl_FragColor = vec4(vCol * uAlpha, uAlpha); }`;

export class RouteBandLayer {
  readonly id = 'tp-band3d';
  readonly type = 'custom';
  readonly renderingMode = '3d';
  private gl: WebGLRenderingContext | null = null;
  private prog: WebGLProgram | null = null;
  private loc: Record<string, any> = {};
  private vbo: WebGLBuffer | null = null;
  private count = 0;
  private runs: BandRun[] = [];
  private dirty = false;
  private origin = [0, 0, 0];

  constructor(private maplibre: any, private map: any) {}

  setRuns(runs: BandRun[]) {
    this.runs = runs;
    this.dirty = true;
    this.map.triggerRepaint();
  }

  onAdd(_map: any, gl: WebGLRenderingContext) {
    this.gl = gl;
    const sh = (type: number, src: string) => { const s = gl.createShader(type)!; gl.shaderSource(s, src); gl.compileShader(s); return s; };
    const p = gl.createProgram()!;
    gl.attachShader(p, sh(gl.VERTEX_SHADER, VS));
    gl.attachShader(p, sh(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(p);
    this.prog = p;
    this.loc.aPos = gl.getAttribLocation(p, 'aPos');
    this.loc.aCol = gl.getAttribLocation(p, 'aCol');
    this.loc.uMvp = gl.getUniformLocation(p, 'uMvp');
    this.loc.uAlpha = gl.getUniformLocation(p, 'uAlpha');
    this.vbo = gl.createBuffer();
    this.dirty = true;
  }

  onRemove() {
    if (this.gl && this.vbo) this.gl.deleteBuffer(this.vbo);
    this.vbo = null;
  }

  /** Ribbon triangles in Mercator units: two triangles per segment, mitred at the joins. */
  private build() {
    const gl = this.gl!;
    const verts: number[] = [];
    const MC = this.maplibre.MercatorCoordinate;
    const first = this.runs.find((r) => r.coords.length);
    if (first) { const c = MC.fromLngLat({ lng: first.coords[0][0], lat: first.coords[0][1] }, 0); this.origin = [c.x, c.y, 0]; }
    const [ox, oy] = this.origin;
    for (const run of this.runs) {
      const n = run.coords.length;
      if (n < 2) continue;
      const pts = run.coords.map((c, i) => MC.fromLngLat({ lng: c[0], lat: c[1] }, (run.heights[i] || 0) + 0.12));
      const mPerUnit = pts[0].meterInMercatorCoordinateUnits();
      const half = (run.width / 2) * mPerUnit;
      const left: number[][] = [], right: number[][] = [];
      for (let i = 0; i < n; i++) {
        const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)];
        let dx = b.x - a.x, dy = b.y - a.y;
        const l = Math.hypot(dx, dy) || 1;
        dx /= l; dy /= l;
        // normal to the left (mercator y points south, so "left of travel" is (dy, -dx) flipped)
        const nx = dy, ny = -dx;
        left.push([pts[i].x - ox + nx * half, pts[i].y - oy + ny * half, pts[i].z]);
        right.push([pts[i].x - ox - nx * half, pts[i].y - oy - ny * half, pts[i].z]);
      }
      const c = run.color;
      for (let i = 0; i < n - 1; i++) {
        const quad = [left[i], right[i], left[i + 1], right[i], right[i + 1], left[i + 1]];
        for (const v of quad) verts.push(v[0], v[1], v[2], c[0], c[1], c[2]);
      }
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(verts), gl.DYNAMIC_DRAW);
    this.count = verts.length / 6;
    this.dirty = false;
  }

  render(gl: WebGLRenderingContext, matrix: number[]) {
    if (!this.prog || !this.vbo) return;
    if (this.dirty) this.build();
    if (!this.count) return;
    gl.useProgram(this.prog);
    gl.uniformMatrix4fv(this.loc.uMvp, false, new Float32Array(withOrigin(matrix, this.origin)));
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.enableVertexAttribArray(this.loc.aPos); gl.vertexAttribPointer(this.loc.aPos, 3, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(this.loc.aCol); gl.vertexAttribPointer(this.loc.aCol, 3, gl.FLOAT, false, 24, 12);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.enable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    // hidden parts first, faintly (x-ray), then the visible band
    gl.depthFunc(gl.GREATER);
    gl.depthMask(false);
    gl.uniform1f(this.loc.uAlpha, 0.28);
    gl.drawArrays(gl.TRIANGLES, 0, this.count);
    gl.depthFunc(gl.LEQUAL);
    gl.depthMask(true);
    gl.uniform1f(this.loc.uAlpha, 0.96);
    gl.drawArrays(gl.TRIANGLES, 0, this.count);
  }
}
