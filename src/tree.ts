// @ts-check
// TREE FELLING, part 1 of 3: WHICH cells are the tree, and WHERE each one sits while the tree turns.
// Pure math and pure reads: no world writes, no ctx, no Three. Runs on the server, in Node and in the browser (the
// renderer decodes the same shape the server encoded), which is what makes every rule here unit-testable.
//
//   findTree    the flood from the cut log: logs up through logs, then the leaves around them, with CAPS, and only
//               NATURAL cells — a player-placed log or leaf is a build, and a build is never felled. It also stops at
//               the border of a neighbouring canopy (a leaf touching someone else's log is theirs).
//   bodyOf      the rigid body: the cells in the frame of the fall (forward / sideways / up), the mass, the centre of
//               mass and the moment of inertia about the hinge — the numbers the physics (./rigid.ts) integrates.
//   cellAt      where one cell of the body is, in the world, at angle `angle`.
//   encode/decodeShape  the body as a short string, so the browser draws the same blocks the server is simulating.

/** The mass of one cell, by kind. A log is the weight; the canopy only adds reach. */
export const MASS = Object.freeze({ log: 1, leaf: 0.25 });

export const LIMITS = Object.freeze({
  logs: 64, // cells of trunk and branch
  blocks: 320, // logs + leaves: the whole body
  leafReach: 4, // steps of canopy out from a log cell
  horizontal: 7, // |dx|, |dz| from the cut, for logs AND leaves: nothing beyond is this tree
  height: 47, // u fits one character of the wire alphabet
  leaves: 3, // fewer leaves than this and it is a pillar of logs, not a tree
});

const KEY = (x, y, z) => `${x},${y},${z}`;
/** The 26 neighbours: a trunk joins its diagonal (a branch leaves the trunk cornerwise). */
const AROUND = [];
for (let x = -1; x <= 1; x++) for (let y = -1; y <= 1; y++) for (let z = -1; z <= 1; z++) if (x || y || z) AROUND.push([x, y, z]);

/**
 * The tree whose foot was just cut at `base`, or null when this is not one (no canopy, too big, a build).
 * `kinds`: `isLog(name)`, `isLeaf(name)` and `isNatural(pos, name, world)` — the three questions the mod answers from
 * the registries and from the world (a natural trunk block is natural by construction; a plain log only when the cell
 * was never edited). `world`: `getBlock(pos)`.
 * @param {{ getBlock(pos: any): string | null }} world
 * @param {{ x: number, y: number, z: number }} base
 * @param {{ isLog(name: string): boolean, isLeaf(name: string): boolean, isNatural(pos: any, name: string, world: any): boolean }} kinds
 */
export function findTree(world, base, kinds) {
  const inReach = (p) => Math.abs(p.x - base.x) <= LIMITS.horizontal && Math.abs(p.z - base.z) <= LIMITS.horizontal
    && p.y >= base.y && p.y - base.y <= LIMITS.height;
  // --- the logs: up from the cut, never down and never sideways past the cap
  const logs = new Map(), queue = [base], seen = new Set([KEY(base.x, base.y, base.z)]);
  while (queue.length) {
    const at = queue.shift();
    for (const [dx, dy, dz] of AROUND) {
      const p = { x: at.x + dx, y: at.y + dy, z: at.z + dz }, key = KEY(p.x, p.y, p.z);
      if (seen.has(key) || !inReach(p)) continue;
      seen.add(key);
      const block = world.getBlock(p);
      if (!block || !kinds.isLog(block) || !kinds.isNatural(p, block, world)) continue;
      if (logs.size >= LIMITS.logs) return null; // a grove grown together, or a wall of logs: leave it alone
      logs.set(key, { x: p.x, y: p.y, z: p.z, block });
      queue.push(p);
    }
  }
  if (!logs.size) return null;
  // --- the canopy: out from the logs, step by step, and a leaf is OURS only while no other trunk is nearer
  const foreign = foreignLogs(world, base, logs, kinds);
  const leaves = new Map();
  let edge = [...logs.values()];
  for (let step = 1; step <= LIMITS.leafReach && edge.length; step++) {
    const next = [];
    for (const at of edge) for (const [dx, dy, dz] of AROUND) {
      const p = { x: at.x + dx, y: at.y + dy, z: at.z + dz }, key = KEY(p.x, p.y, p.z);
      if (leaves.has(key) || logs.has(key) || !inReach(p)) continue;
      const block = world.getBlock(p);
      if (!block || !kinds.isLeaf(block) || !kinds.isNatural(p, block, world)) continue;
      if (nearer(foreign, p, step)) continue; // this leaf hangs on the tree next door, not on ours
      if (logs.size + leaves.size >= LIMITS.blocks) return null;
      leaves.set(key, { x: p.x, y: p.y, z: p.z, block });
      next.push(p);
    }
    edge = next;
  }
  if (leaves.size < LIMITS.leaves) return null; // a pillar of logs is not a tree
  return { logs: [...logs.values()], leaves: [...leaves.values()] };
}

/**
 * Every log around the tree that is NOT part of it — the trunk of the tree next door, the wall of a cabin. One pass
 * over the box that can hold a cell within `leafReach` of a leaf of ours, so the canopy rule below costs no reads.
 * Natural or built makes no difference here: either way that trunk owns the leaves nearest to it.
 */
function foreignLogs(world, base, logs, kinds) {
  // the box is the TREE's own extent widened by `leafReach` (not the whole cap): a plain oak costs a quarter of what
  // the widest allowed tree would
  let x0 = base.x, x1 = base.x, z0 = base.z, z1 = base.z, top = base.y;
  for (const c of logs.values()) {
    if (c.x < x0) x0 = c.x; if (c.x > x1) x1 = c.x;
    if (c.z < z0) z0 = c.z; if (c.z > z1) z1 = c.z;
    if (c.y > top) top = c.y;
  }
  const r = LIMITS.leafReach * 2; // our canopy reaches `leafReach`, and a foreign log that bounds it, as much again
  const out = [];
  for (let x = x0 - r; x <= x1 + r; x++) for (let z = z0 - r; z <= z1 + r; z++) {
    for (let y = base.y; y <= top + r; y++) {
      if (logs.has(KEY(x, y, z))) continue;
      const block = world.getBlock({ x, y, z });
      if (block && kinds.isLog(block)) out.push({ x, y, z });
    }
  }
  return out;
}

/** Is one of those trunks STRICTLY nearer to `p` than our own canopy is (which is `step` cells away)? */
function nearer(foreign, p, step) {
  for (const c of foreign) {
    if (Math.max(Math.abs(c.x - p.x), Math.abs(c.y - p.y), Math.abs(c.z - p.z)) < step) return true;
  }
  return false;
}

/** The tree falls AWAY from whoever cut it, along the nearer axis. */
export function fallDirection(base, from) {
  const dx = base.x + 0.5 - from.x, dz = base.z + 0.5 - from.z;
  if (Math.abs(dx) >= Math.abs(dz)) return { x: dx >= 0 ? 1 : -1, z: 0 };
  return { x: 0, z: dz >= 0 ? 1 : -1 };
}

/** Only an axe fells; any other tool (or a bare hand) breaks the one block, as always. */
export const isAxe = (name) => typeof name === 'string' && name.endsWith('_axe');

// ---------------------------------------------------------------- the rigid body
// The frame of the fall, in CELLS, centred on the cut: `f` forward (the fall direction), `s` sideways, `u` up. The
// HINGE is the bottom edge of the stump cell on the forward side: (f, u) = (0.5, -0.5). Turning by `angle` sends +u
// toward +f, which is a tree tipping over its stump.
export const PIVOT_F = 0.5, PIVOT_U = -0.5;

/**
 * The body of a found tree: its cells in the frame of the fall plus the mass, the centre of mass and the moment of
 * inertia about the hinge. `palette` is the block names in the order the cells cite them.
 */
export function bodyOf(base, direction, tree) {
  const side = { x: -direction.z, z: direction.x };
  const palette = [];
  const indexOf = (name) => { const i = palette.indexOf(name); return i >= 0 ? i : (palette.push(name) - 1); };
  const cells = [];
  for (const [list, kind] of [[tree.logs, 'log'], [tree.leaves, 'leaf']]) for (const c of list) {
    const dx = c.x - base.x, dz = c.z - base.z;
    cells.push({
      f: dx * direction.x + dz * direction.z,
      s: dx * side.x + dz * side.z,
      u: c.y - base.y,
      log: kind === 'log',
      block: indexOf(c.block),
    });
  }
  let mass = 0, fm = 0, sm = 0, um = 0;
  for (const c of cells) { const m = c.log ? MASS.log : MASS.leaf; mass += m; fm += m * c.f; sm += m * c.s; um += m * c.u; }
  const com = { f: fm / mass, s: sm / mass, u: um / mass };
  // about the hinge axis: the cells' distance to it, plus each unit cube's own m/6
  let inertia = 0;
  for (const c of cells) {
    const m = c.log ? MASS.log : MASS.leaf, df = c.f - PIVOT_F, du = c.u - PIVOT_U;
    inertia += m * (df * df + du * du) + m / 6;
  }
  return { base: { x: base.x, y: base.y, z: base.z }, direction, side, cells, palette, mass, com, inertia };
}

/** The CELL this body cell occupies in the world at `angle` (0 = still standing). */
export function cellAt(body, cell, angle) {
  const cos = Math.cos(angle), sin = Math.sin(angle);
  const df = cell.f - PIVOT_F, du = cell.u - PIVOT_U;
  const f = Math.round(PIVOT_F + df * cos + du * sin), u = Math.round(PIVOT_U - df * sin + du * cos);
  return {
    x: body.base.x + body.direction.x * f + body.side.x * cell.s,
    y: body.base.y + u,
    z: body.base.z + body.direction.z * f + body.side.z * cell.s,
  };
}

/** How far forward the centre of mass is from the hinge at `angle`: the lever gravity turns the tree by. */
export function lever(body, angle) {
  return (body.com.f - PIVOT_F) * Math.cos(angle) + (body.com.u - PIVOT_U) * Math.sin(angle);
}

/** The height of the centre of mass over the hinge at `angle` (the potential energy, for the tests). */
export function comHeight(body, angle) {
  return -(body.com.f - PIVOT_F) * Math.sin(angle) + (body.com.u - PIVOT_U) * Math.cos(angle);
}

// ---------------------------------------------------------------- the shape on the wire
// One cell = 4 characters of a 64-letter alphabet: f + 32, s + 32, u, and the palette index. No base64, no Buffer:
// the same four lines of code encode on the server and decode in the browser.
const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_-';
const CODE = new Map([...ALPHABET].map((c, i) => [c, i]));
const OFF = 32;

export function encodeShape(body) {
  let out = '';
  for (const c of body.cells) {
    out += ALPHABET[c.f + OFF] + ALPHABET[c.s + OFF] + ALPHABET[c.u] + ALPHABET[c.block * 2 + (c.log ? 1 : 0)];
  }
  return out;
}

export function decodeShape(text) {
  const cells = [];
  for (let i = 0; i + 3 < text.length; i += 4) {
    const f = CODE.get(text[i]), s = CODE.get(text[i + 1]), u = CODE.get(text[i + 2]), k = CODE.get(text[i + 3]);
    if (f === undefined || s === undefined || u === undefined || k === undefined) return null;
    cells.push({ f: f - OFF, s: s - OFF, u, log: (k & 1) === 1, block: k >> 1 });
  }
  return cells;
}
