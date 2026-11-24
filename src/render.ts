// @ts-check
// THE BROWSER's half of the felling: ONE merged mesh per falling tree, turning on the hinge the server turns it on.
//
// The entity the server anchored on the stump is drawn by this renderer, and nothing else about it is drawn: no body,
// no name, no health. The mesh is built ONCE, from the shape string the server sent (./tree.ts decodeShape), as one
// cube per cell with the block's own atlas cells (`kit.blockTexture`) — a face between a cell and a LOG beside it is
// dropped, since nothing can see it. Logs and leaves go in two meshes because the canopy needs the cutout material.
//
// Each frame the renderer only moves ONE node: the hinge group. The angle it shows chases the last angle the server
// sent (20 Hz) with an exponential ease, so a browser at 144 fps sees a continuous fall out of 20 samples a second.
// The group the engine gives every mob carries the mob's yaw; a tree has no yaw, so an intermediate node cancels it.

import { decodeShape, PIVOT_F, PIVOT_U } from './tree.ts';

const EASE = 14; // per second: how fast the drawn angle catches the server's
const FACE_DIR = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]; // BoxGeometry's face order
const FACE_TILE = ['side', 'side', 'top', 'bottom', 'side', 'side'];

/** The shapes and angles the server sent, by entity id. The net handler fills it, the renderer reads it. */
export function createTreeStore() {
  const trees = new Map();
  return {
    trees,
    shape(d) {
      if (!d || typeof d.cells !== 'string' || !Array.isArray(d.pal)) return;
      const cells = decodeShape(d.cells);
      if (!cells || !cells.length) return;
      const was = trees.get(d.id);
      trees.set(d.id, {
        cells, palette: d.pal, direction: { x: d.dx | 0, z: d.dz | 0 },
        target: was?.target ?? 0, shown: was?.shown ?? 0,
      });
    },
    pose(d) {
      const t = d && trees.get(d.id);
      if (t) t.target = (Number(d.a) || 0) / 100;
    },
    forget(id) { trees.delete(id); },
  };
}

/** One cube per cell, merged, with the atlas cells of each cell's own block. `ask(name)` is kit.blockTexture. */
export function buildTreeMesh(THREE, tree, ask) {
  const template = new THREE.BoxGeometry(1, 1, 1);
  const tPos = template.attributes.position.array, tNor = template.attributes.normal.array;
  const tUv = template.attributes.uv.array, tIdx = template.index.array;
  const side = { x: -tree.direction.z, z: tree.direction.x };
  // local coordinates, doubled so a cell key is an integer: the hinge is the origin
  const key = (f, s, u) => `${Math.round(2 * (tree.direction.x * (f - PIVOT_F) + side.x * s))},${Math.round(2 * (u - PIVOT_U))},${Math.round(2 * (tree.direction.z * (f - PIVOT_F) + side.z * s))}`;
  const logs = new Set();
  for (const c of tree.cells) if (c.log) logs.add(key(c.f, c.s, c.u));
  const groups = [[], []]; // 0 = logs (opaque), 1 = leaves (cutout)
  for (const c of tree.cells) groups[c.log ? 0 : 1].push(c);
  const out = [];
  for (let pass = 0; pass < 2; pass++) {
    const cells = groups[pass];
    if (!cells.length) continue;
    const pos = [], nor = [], uv = [], idx = [];
    for (const c of cells) {
      const cx = tree.direction.x * (c.f - PIVOT_F) + side.x * c.s;
      const cy = c.u - PIVOT_U;
      const cz = tree.direction.z * (c.f - PIVOT_F) + side.z * c.s;
      const tex = ask(tree.palette[c.block] ?? '');
      const base = pos.length / 3;
      for (let v = 0; v < 24; v++) {
        pos.push(tPos[v * 3] + cx, tPos[v * 3 + 1] + cy, tPos[v * 3 + 2] + cz);
        nor.push(tNor[v * 3], tNor[v * 3 + 1], tNor[v * 3 + 2]);
        const cell = tex ? (tex[FACE_TILE[v >> 2]] ?? tex.side) : null;
        if (cell) uv.push(cell[0] + tUv[v * 2] * (cell[2] - cell[0]), cell[1] + tUv[v * 2 + 1] * (cell[3] - cell[1]));
        else uv.push(tUv[v * 2], tUv[v * 2 + 1]);
      }
      for (let face = 0; face < 6; face++) {
        const [dx, dy, dz] = FACE_DIR[face];
        // a face against a log is never seen: the trunk is opaque and the two cells touch
        if (logs.has(`${Math.round(2 * cx) + 2 * dx},${Math.round(2 * cy) + 2 * dy},${Math.round(2 * cz) + 2 * dz}`)) continue;
        for (let k = 0; k < 6; k++) idx.push(base + tIdx[face * 6 + k]);
      }
    }
    if (!idx.length) continue;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setIndex(idx);
    const texture = ask(tree.palette[cells[0].block] ?? '')?.texture ?? null;
    const material = new THREE.MeshLambertMaterial(pass === 0
      ? { map: texture }
      : { map: texture, alphaTest: 0.5, transparent: false, side: THREE.DoubleSide });
    out.push(new THREE.Mesh(geo, material));
  }
  template.dispose();
  return out;
}

/** The renderer of the falling-tree entity. `store` is what createTreeStore returned. */
export function treeRendererFor(store) {
  return {
    /** Nothing to draw yet: the shape may still be on the wire. The hinge node is all that is built up front. */
    build({ THREE }) {
      const group = new THREE.Group();
      const yawFix = new THREE.Group(); // the engine turns the mob's group by its yaw; a tree has none
      const hinge = new THREE.Group();
      yawFix.add(hinge);
      group.add(yawFix);
      return { group, legs: [], arms: [], yawFix, hinge, built: false };
    },
    animate(m, frame, kit) {
      const model = m.model, tree = store.trees.get(m.id);
      if (!tree) return;
      if (!model.built) {
        model.built = true;
        for (const mesh of buildTreeMesh(kit.THREE, tree, (name) => { try { return kit.blockTexture?.(name) ?? null; } catch { return null; } })) model.hinge.add(mesh);
      }
      // the hinge sits half a cell forward of the stump's centre, on the ground
      model.hinge.position.set(tree.direction.x * PIVOT_F, 0, tree.direction.z * PIVOT_F);
      model.yawFix.rotation.y = -model.group.rotation.y;
      const k = 1 - Math.exp(-Math.max(0, frame.dt) * EASE);
      tree.shown += (tree.target - tree.shown) * k;
      const axis = new kit.THREE.Vector3(-tree.direction.z, 0, tree.direction.x);
      model.hinge.quaternion.setFromAxisAngle(axis, -tree.shown);
    },
  };
}
