import type { LngLat } from '../types';
import { PX_PER_M_Z0 } from './roadlayers';

/**
 * A 3-D car on the map: a MapLibre custom layer that draws a glTF binary (.glb) at the car's
 * position, turned to its heading and lit from above. No three.js — the loader below reads just
 * what a car model needs (nodes with TRS, triangle primitives with POSITION/NORMAL/TEXCOORD_0,
 * normalised integer attributes from KHR_mesh_quantization, PBR base colour + texture, BLEND
 * alpha for glass) and bakes everything into one buffer per material.
 *
 * Models are normalised on load: Y-up glTF → metres, longest horizontal axis along the car's
 * length, wheels on the ground. The "primary" (paint) material takes the user's colour.
 */

export interface CarModelOptions {
  url: string;
  /** Material names (regex) that get the user's paint colour. */
  paint?: RegExp;
  /** Real length of the car, metres (the model is scaled to it). */
  length?: number;
  /** Which model axis points forward: '-z' (glTF convention) or '+z'. */
  forward?: '-z' | '+z';
}

interface Batch {
  vbo: WebGLBuffer; ibo: WebGLBuffer; count: number;
  color: [number, number, number, number]; emissive: number; tex: WebGLTexture | null; blend: boolean; paint: boolean;
}

const VS = `
attribute vec3 aPos; attribute vec3 aNrm; attribute vec2 aUv;
uniform mat4 uMvp; uniform mat3 uRot;
varying vec3 vN; varying vec2 vUv;
void main() { vN = normalize(uRot * aNrm); vUv = aUv; gl_Position = uMvp * vec4(aPos, 1.0); }`;
const FS = `
precision mediump float;
varying vec3 vN; varying vec2 vUv;
uniform vec4 uColor; uniform float uEmissive; uniform sampler2D uTex; uniform float uHasTex; uniform vec3 uLight;
void main() {
  vec4 base = uColor;
  if (uHasTex > 0.5) base *= texture2D(uTex, vUv);
  vec3 n = normalize(vN);
  float diff = max(dot(n, uLight), 0.0);
  float sky = 0.5 + 0.5 * max(n.z, 0.0);
  float spec = pow(max(dot(normalize(uLight + vec3(0.0, 0.0, 1.0)), n), 0.0), 24.0) * 0.25;
  vec3 c = base.rgb * (0.5 * sky + 0.62 * diff) + spec + base.rgb * uEmissive;
  gl_FragColor = vec4(c, base.a);
}`;

type Mat4 = Float64Array | number[];

function mul(a: Mat4, b: Mat4): Float64Array {
  const o = new Float64Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
  return o;
}
function trs(t?: number[], r?: number[], s?: number[]): Float64Array {
  const [x, y, z, w] = r || [0, 0, 0, 1];
  const [sx, sy, sz] = s || [1, 1, 1];
  const [tx, ty, tz] = t || [0, 0, 0];
  return new Float64Array([
    (1 - 2 * (y * y + z * z)) * sx, (2 * (x * y + z * w)) * sx, (2 * (x * z - y * w)) * sx, 0,
    (2 * (x * y - z * w)) * sy, (1 - 2 * (x * x + z * z)) * sy, (2 * (y * z + x * w)) * sy, 0,
    (2 * (x * z + y * w)) * sz, (2 * (y * z - x * w)) * sz, (1 - 2 * (x * x + y * y)) * sz, 0,
    tx, ty, tz, 1,
  ]);
}
const xformP = (m: Mat4, v: number[]) => [m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12], m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13], m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14]];
const xformN = (m: Mat4, v: number[]) => {
  const o = [m[0] * v[0] + m[4] * v[1] + m[8] * v[2], m[1] * v[0] + m[5] * v[1] + m[9] * v[2], m[2] * v[0] + m[6] * v[1] + m[10] * v[2]];
  const l = Math.hypot(o[0], o[1], o[2]) || 1;
  return [o[0] / l, o[1] / l, o[2] / l];
};

interface Parsed {
  batches: { pos: number[]; nrm: number[]; uv: number[]; idx: number[]; color: number[]; emissive: number; image: Blob | null; blend: boolean; paint: boolean }[];
}

function readAccessor(json: any, bin: ArrayBuffer, index: number): { data: number[][]; } {
  const acc = json.accessors[index];
  const bv = json.bufferViews[acc.bufferView];
  const comp = { 5120: Int8Array, 5121: Uint8Array, 5122: Int16Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array }[acc.componentType as number] as any;
  const n = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[acc.type as string] as number;
  const elemSize = comp.BYTES_PER_ELEMENT as number;
  const stride = bv.byteStride || n * elemSize;
  const base = (bv.byteOffset || 0) + (acc.byteOffset || 0);
  const out: number[][] = new Array(acc.count);
  const norm = acc.normalized ? (comp === Int8Array ? 127 : comp === Uint8Array ? 255 : comp === Int16Array ? 32767 : comp === Uint16Array ? 65535 : 1) : 1;
  for (let i = 0; i < acc.count; i++) {
    const arr = new comp(bin, base + i * stride, n);
    const v: number[] = new Array(n);
    for (let k = 0; k < n; k++) v[k] = acc.normalized ? Math.max(-1, arr[k] / norm) : arr[k];
    out[i] = v;
  }
  return { data: out };
}

function parseGlb(buf: ArrayBuffer, opts: CarModelOptions): Parsed {
  const dv = new DataView(buf);
  if (dv.getUint32(0, true) !== 0x46546c67) throw new Error('not a glb');
  const jsonLen = dv.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 20, jsonLen)));
  const binStart = 20 + jsonLen + 8;
  const bin = buf.slice(binStart, binStart + dv.getUint32(20 + jsonLen, true));
  const paint = opts.paint || /^primary$|paint|body/i;
  // Gather primitives with their world matrices.
  const prims: { world: Float64Array; prim: any }[] = [];
  const visit = (ni: number, parent: Float64Array) => {
    const node = json.nodes[ni];
    const local = node.matrix ? new Float64Array(node.matrix) : trs(node.translation, node.rotation, node.scale);
    const world = mul(parent, local);
    if (node.mesh !== undefined) for (const prim of json.meshes[node.mesh].primitives) if (!prim.mode || prim.mode === 4) prims.push({ world, prim });
    for (const c of node.children || []) visit(c, world);
  };
  const ident = trs();
  for (const n of json.scenes[json.scene || 0].nodes) visit(n, ident);
  // Bake geometry per material.
  const byMat = new Map<number, Parsed['batches'][0]>();
  for (const { world, prim } of prims) {
    const mi = prim.material ?? -1;
    let b = byMat.get(mi);
    if (!b) {
      const m = mi >= 0 ? json.materials[mi] : {};
      const pbr = m.pbrMetallicRoughness || {};
      let image: Blob | null = null;
      if (pbr.baseColorTexture) {
        const tex = json.textures[pbr.baseColorTexture.index];
        const src = tex.extensions?.EXT_texture_webp?.source ?? tex.source;
        const img = json.images[src];
        const bv = json.bufferViews[img.bufferView];
        image = new Blob([new Uint8Array(bin, bv.byteOffset || 0, bv.byteLength)], { type: img.mimeType });
      }
      const em = m.emissiveFactor ? Math.max(...(m.emissiveFactor as number[])) : 0;
      b = { pos: [], nrm: [], uv: [], idx: [], color: pbr.baseColorFactor || [1, 1, 1, 1], emissive: em, image, blend: m.alphaMode === 'BLEND', paint: paint.test(m.name || '') && !pbr.baseColorTexture };
      byMat.set(mi, b);
    }
    const P = readAccessor(json, bin, prim.attributes.POSITION).data;
    const N = prim.attributes.NORMAL !== undefined ? readAccessor(json, bin, prim.attributes.NORMAL).data : null;
    const U = prim.attributes.TEXCOORD_0 !== undefined ? readAccessor(json, bin, prim.attributes.TEXCOORD_0).data : null;
    const I = prim.indices !== undefined ? readAccessor(json, bin, prim.indices).data.map((v) => v[0]) : P.map((_, i) => i);
    const base = b.pos.length / 3;
    for (let i = 0; i < P.length; i++) {
      b.pos.push(...xformP(world, P[i]));
      b.nrm.push(...(N ? xformN(world, N[i]) : [0, 1, 0]));
      b.uv.push(U ? U[i][0] : 0, U ? U[i][1] : 0);
    }
    for (const i of I) b.idx.push(base + i);
  }
  const batches = [...byMat.values()].filter((b) => b.idx.length);
  // Normalise: Y-up → Z-up metres, centred, wheels at z = 0, nose along +y (north) at heading 0.
  let min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const b of batches) for (let i = 0; i < b.pos.length; i += 3) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], b.pos[i + k]); max[k] = Math.max(max[k], b.pos[i + k]); }
  const size = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  const alongX = size[0] > size[2];                       // which horizontal axis is the car's length
  const len = Math.max(size[0], size[2]) || 1;
  const s = (opts.length || 4.7) / len;
  const fwd = opts.forward === '+z' ? 1 : -1;
  const cx = (min[0] + max[0]) / 2, cz = (min[2] + max[2]) / 2, y0 = min[1];
  for (const b of batches) {
    for (let i = 0; i < b.pos.length; i += 3) {
      const x = b.pos[i] - cx, y = b.pos[i + 1] - y0, z = b.pos[i + 2] - cz;
      // model (x right, y up, z back) → world (x east/right, y north/forward, z up); a proper rotation, no mirror
      const [X, Y] = alongX ? [z * fwd, x * fwd] : [-x * fwd, z * fwd];
      b.pos[i] = X * s; b.pos[i + 1] = Y * s; b.pos[i + 2] = y * s;
    }
    for (let i = 0; i < b.nrm.length; i += 3) {
      const x = b.nrm[i], y = b.nrm[i + 1], z = b.nrm[i + 2];
      const [X, Y] = alongX ? [z * fwd, x * fwd] : [-x * fwd, z * fwd];
      b.nrm[i] = X; b.nrm[i + 1] = Y; b.nrm[i + 2] = y;
    }
  }
  return { batches };
}

export class CarLayer {
  readonly id = 'tp-car';
  readonly type = 'custom';
  readonly renderingMode = '3d';
  private gl: WebGLRenderingContext | null = null;
  private prog: WebGLProgram | null = null;
  private loc: Record<string, any> = {};
  private batches: Batch[] = [];
  private parsed: Parsed | null = null;
  private pos: LngLat | null = null;
  private heading = 0;
  private paint: [number, number, number] = [0.9, 0.9, 0.92];
  visible = true;
  ready = false;
  onReady: (() => void) | null = null;

  constructor(private maplibre: any, private map: any, private opts: CarModelOptions) {
    fetch(opts.url).then((r) => { if (!r.ok) throw new Error(`model ${r.status}`); return r.arrayBuffer(); })
      .then((buf) => { this.parsed = parseGlb(buf, opts); if (this.gl) this.upload(); })
      .catch((e) => console.warn('[car3d]', e));
  }

  setPaint(hex: string) {
    const n = parseInt(hex.replace('#', ''), 16);
    this.paint = [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  }

  /** Where the car is and which way it points (degrees clockwise from north). */
  update(pos: LngLat | null, heading: number) {
    this.pos = pos;
    this.heading = heading;
    if (this.ready && this.visible) this.map.triggerRepaint();
  }

  onAdd(_map: any, gl: WebGLRenderingContext) {
    this.gl = gl;
    const sh = (type: number, src: string) => { const s = gl.createShader(type)!; gl.shaderSource(s, src); gl.compileShader(s); return s; };
    const p = gl.createProgram()!;
    gl.attachShader(p, sh(gl.VERTEX_SHADER, VS));
    gl.attachShader(p, sh(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(p);
    this.prog = p;
    for (const n of ['aPos', 'aNrm', 'aUv']) this.loc[n] = gl.getAttribLocation(p, n);
    for (const n of ['uMvp', 'uRot', 'uColor', 'uEmissive', 'uTex', 'uHasTex', 'uLight']) this.loc[n] = gl.getUniformLocation(p, n);
    if (this.parsed) this.upload();
  }

  onRemove() {
    const gl = this.gl;
    if (!gl) return;
    for (const b of this.batches) { gl.deleteBuffer(b.vbo); gl.deleteBuffer(b.ibo); if (b.tex) gl.deleteTexture(b.tex); }
    this.batches = [];
    this.ready = false;
  }

  private upload() {
    const gl = this.gl!;
    const p = this.parsed!;
    this.batches = [];
    for (const b of p.batches) {
      const n = b.pos.length / 3;
      const inter = new Float32Array(n * 8);
      for (let i = 0; i < n; i++) {
        inter.set([b.pos[i * 3], b.pos[i * 3 + 1], b.pos[i * 3 + 2], b.nrm[i * 3], b.nrm[i * 3 + 1], b.nrm[i * 3 + 2], b.uv[i * 2], b.uv[i * 2 + 1]], i * 8);
      }
      const vbo = gl.createBuffer()!;
      gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
      gl.bufferData(gl.ARRAY_BUFFER, inter, gl.STATIC_DRAW);
      const ibo = gl.createBuffer()!;
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint32Array(b.idx), gl.STATIC_DRAW);
      const batch: Batch = { vbo, ibo, count: b.idx.length, color: b.color as any, emissive: b.emissive, tex: null, blend: b.blend, paint: b.paint };
      if (b.image) {
        createImageBitmap(b.image, { imageOrientation: 'flipY' as any }).then((bmp) => {
          const tex = gl.createTexture()!;
          gl.bindTexture(gl.TEXTURE_2D, tex);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bmp);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
          batch.tex = tex;
          this.map.triggerRepaint();
        }, () => undefined);
      }
      this.batches.push(batch);
    }
    gl.getExtension('OES_element_index_uint');
    this.batches.sort((a, b) => Number(a.blend) - Number(b.blend));
    this.ready = true;
    if (this.onReady) this.onReady();
    this.map.triggerRepaint();
  }

  render(gl: WebGLRenderingContext, matrix: number[]) {
    if (!this.ready || !this.visible || !this.pos || !this.prog) return;
    const mc = this.maplibre.MercatorCoordinate.fromLngLat({ lng: this.pos[0], lat: this.pos[1] }, 0);
    const mPerUnit = mc.meterInMercatorCoordinateUnits();
    // Nav apps draw the car a little bigger than life so it reads at any zoom: at least ~48 px long.
    const pxPerM = (2 ** this.map.getZoom()) * PX_PER_M_Z0;
    const scale = mPerUnit * Math.max(1, 48 / ((this.opts.length || 4.7) * pxPerM));
    const h = (this.heading * Math.PI) / 180;
    // World frame of the model: x east, y north, z up. Mercator: x east, y SOUTH, z up.
    const fx = Math.sin(h), fy = -Math.cos(h);          // forward in mercator
    const rx = Math.cos(h), ry = Math.sin(h);           // right in mercator
    const model = [
      rx * scale, ry * scale, 0, 0,
      fx * scale, fy * scale, 0, 0,
      0, 0, scale, 0,
      mc.x, mc.y, 0.0, 1,
    ];
    const mvp = mul(matrix, model);
    const rot = [rx, ry, 0, fx, fy, 0, 0, 0, 1];           // normals: no scale
    gl.useProgram(this.prog);
    gl.uniformMatrix4fv(this.loc.uMvp, false, new Float32Array(mvp as any));
    gl.uniformMatrix3fv(this.loc.uRot, false, new Float32Array(rot));
    gl.uniform3f(this.loc.uLight, -0.35, -0.5, 0.79);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.disable(gl.CULL_FACE);
    for (const b of this.batches) {
      gl.depthMask(!b.blend);
      gl.bindBuffer(gl.ARRAY_BUFFER, b.vbo);
      gl.enableVertexAttribArray(this.loc.aPos); gl.vertexAttribPointer(this.loc.aPos, 3, gl.FLOAT, false, 32, 0);
      gl.enableVertexAttribArray(this.loc.aNrm); gl.vertexAttribPointer(this.loc.aNrm, 3, gl.FLOAT, false, 32, 12);
      gl.enableVertexAttribArray(this.loc.aUv); gl.vertexAttribPointer(this.loc.aUv, 2, gl.FLOAT, false, 32, 24);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, b.ibo);
      const c = b.paint ? [this.paint[0], this.paint[1], this.paint[2], 1] : b.color;
      gl.uniform4f(this.loc.uColor, c[0], c[1], c[2], c[3] ?? 1);
      gl.uniform1f(this.loc.uEmissive, b.emissive);
      gl.uniform1f(this.loc.uHasTex, b.tex ? 1 : 0);
      if (b.tex) { gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, b.tex); gl.uniform1i(this.loc.uTex, 0); }
      gl.drawElements(gl.TRIANGLES, b.count, gl.UNSIGNED_INT, 0);
    }
    gl.depthMask(true);
  }
}
