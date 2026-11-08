// Shrink a car GLB for the map marker: node scripts/car/optimize.mjs (needs @gltf-transform/core, /functions, /extensions, meshoptimizer, sharp; edit the file names below)

// Remove interior parts (unseen from above) and anything tiny, then optimise.
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, prune, simplify, weld, textureCompress, flatten, join, quantize } from '@gltf-transform/functions';
import { MeshoptSimplifier } from 'meshoptimizer';
import sharp from 'sharp';
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const doc = await io.read(process.argv[2] || 'model3.glb');
const INTERIOR = /carpet|seat|lcd|button|belt|mirror_inside|dvor|movsteer|suspensi|platnomor|putih|hitam|plastic\.0|texture_buttons|door_lf/i;
let removed = 0;
for (const mesh of doc.getRoot().listMeshes()) {
  for (const prim of mesh.listPrimitives()) {
    const m = prim.getMaterial();
    if (m && INTERIOR.test(m.getName())) { prim.dispose(); removed++; }
  }
  if (!mesh.listPrimitives().length) mesh.dispose();
}
console.log('removed interior primitives', removed);
await doc.transform(
  flatten(), dedup(), prune(),
  weld(), simplify({ simplifier: MeshoptSimplifier, ratio: 0.07, error: 0.008 }),
  join(), dedup(), prune(),
  quantize({ quantizePosition: 14, quantizeNormal: 8, quantizeTexcoord: 12 }),
  textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [192, 192], quality: 65 }),
);
await io.write(process.argv[3] || 'public/models/car.glb', doc);
