/**
 * Smooth 3-D surfaces for the lane model: a MapLibre custom layer that draws triangle strips with
 * a height per vertex — bridge decks, their lane markings and parapets, as built by lanes.py ('m3').
 * fill-extrusion can only make flat-topped slabs, so ramps would step; these strips follow the real
 * gradient. Lit by a fixed sky light (walls darker than tops) and depth-tested with the rest of the
 * 3-D scene. Strips of a structure the car is about to drive under are drawn translucent.
 */

export interface Strip { id: string; s: string; pts: number[][]; color: [number, number, number] }

const VS = `
attribute vec3 aPos; attribute vec4 aCol;
uniform mat4 uMvp; varying vec4 vCol;
void main() { vCol = aCol; gl_Position = uMvp * vec4(aPos, 1.0); }`;
const FS = `
precision mediump float; varying vec4 vCol; uniform float uAlpha;
void main() { float a = vCol.a * uAlpha; gl_FragColor = vec4(vCol.rgb * a, a); }`;

export class MeshLayer {
  readonly type = 'custom';
  readonly renderingMode = '3d';
  private gl: WebGLRenderingContext | null = null;
  private prog: WebGLProgram | null = null;
  private loc: Record<string, any> = {};
  private vbo: WebGLBuffer | null = null;
  private xvbo: WebGLBuffer | null = null;
  private count = 0;
  private xcount = 0;
  private strips: Strip[] = [];
  private xray = new Set<string>();
  private dirty = false;
  /** Vertices are stored relative to this Mercator origin: 32-bit floats can't hold absolute Mercator coordinates to the centimetre. */
  private origin = [0, 0, 0];

  constructor(readonly id: string, private maplibre: any, private map: any) {}

  setStrips(strips: Strip[]) { this.strips = strips; this.dirty = true; this.map.triggerRepaint(); }
  setXray(ids: string[]) { this.xray = new Set(ids); this.dirty = true; this.map.triggerRepaint(); }

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
    this.xvbo = gl.createBuffer();
    this.dirty = true;
  }

  onRemove() {
    if (!this.gl) return;
    if (this.vbo) this.gl.deleteBuffer(this.vbo);
    if (this.xvbo) this.gl.deleteBuffer(this.xvbo);
    this.vbo = this.xvbo = null;
  }

  private build() {
    const gl = this.gl!;
    const MC = this.maplibre.MercatorCoordinate;
    const solid: number[] = [], seeThrough: number[] = [];
    const first = this.strips.find((st) => st.pts.length);
    if (first) { const c = MC.fromLngLat({ lng: first.pts[0][0], lat: first.pts[0][1] }, first.pts[0][2]); this.origin = [c.x, c.y, c.z]; }
    const [ox, oy, oz] = this.origin;
    for (const st of this.strips) {
      const out = this.xray.has(st.s) ? seeThrough : solid;
      const n = st.pts.length;
      if (n < 4) continue;
      const m = st.pts.map((p) => { const c = MC.fromLngLat({ lng: p[0], lat: p[1] }, p[2]); return [c.x - ox, c.y - oy, c.z - oz]; });
      const [r, g, b] = st.color;
      for (let i = 0; i + 2 < n; i++) {
        // triangle strip → triangles, consistent winding not needed (no culling); light by slope
        const a = m[i], bb = m[i + 1], c = m[i + 2];
        const ux = bb[0] - a[0], uy = bb[1] - a[1], uz = bb[2] - a[2];
        const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
        const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
        const len = Math.hypot(nx, ny, nz) || 1;
        const up = Math.abs(nz / len);                    // 1 = flat top, 0 = vertical wall
        const shade = 0.62 + 0.38 * up;
        for (const v of [a, bb, c]) out.push(v[0], v[1], v[2], r * shade, g * shade, b * shade, 1);
      }
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(solid), gl.STATIC_DRAW);
    this.count = solid.length / 7;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.xvbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(seeThrough), gl.STATIC_DRAW);
    this.xcount = seeThrough.length / 7;
    this.dirty = false;
  }

  render(gl: WebGLRenderingContext, matrix: number[]) {
    if (!this.prog || !this.vbo) return;
    if (this.dirty) this.build();
    if (!this.count && !this.xcount) return;
    gl.useProgram(this.prog);
    gl.uniformMatrix4fv(this.loc.uMvp, false, new Float32Array(withOrigin(matrix, this.origin)));
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.disable(gl.CULL_FACE);
    const draw = (vbo: WebGLBuffer, count: number, alpha: number) => {
      gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
      gl.enableVertexAttribArray(this.loc.aPos); gl.vertexAttribPointer(this.loc.aPos, 3, gl.FLOAT, false, 28, 0);
      gl.enableVertexAttribArray(this.loc.aCol); gl.vertexAttribPointer(this.loc.aCol, 4, gl.FLOAT, false, 28, 12);
      gl.uniform1f(this.loc.uAlpha, alpha);
      gl.drawArrays(gl.TRIANGLES, 0, count);
    };
    gl.depthMask(true);
    if (this.count) draw(this.vbo, this.count, 1);
    if (this.xcount) { gl.depthMask(false); draw(this.xvbo!, this.xcount, 0.3); gl.depthMask(true); }
  }
}

/** matrix × translate(origin), in double precision, so vertices can be stored relative to the origin. */
export function withOrigin(m: number[], o: number[]): number[] {
  const out = m.slice();
  for (let r = 0; r < 4; r++) out[12 + r] = m[r] * o[0] + m[4 + r] * o[1] + m[8 + r] * o[2] + m[12 + r];
  return out;
}
