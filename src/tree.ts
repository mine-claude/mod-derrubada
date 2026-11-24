// @ts-check
// TREE FELLING, part 1 of 3: WHICH cells are the tree, and WHERE each one sits while the tree turns.
// Pure math and pure reads: no world writes, no ctx, no Three. Runs on the server, in Node and in the browser (the
// renderer decodes the same shape the server encoded), which is what makes every rule here unit-testable.
//
// A TREE IS NOT A SHAPE. Nothing here knows what a tree looks like: no "straight trunk", no "crown over the top", no
// box around the cut. A tree is CONNECTED NATURAL WOOD plus the FOLIAGE that hangs nearest to it, and the only
// questions asked of the content are the three in `kinds` (is this wood, is this foliage, is this cell natural). That
// is what lets a mod grow a 2x2 trunk, a palm that curves out of its own column, a tree that forks into branches, a
// canopy forty cells wide or a mushroom the size of a house, with no change to this file.
//
//   findTree    the flood from the cut: the connected wood, then the foliage around it, with per-tree CAPS, and only
//               NATURAL cells — a player-placed log or leaf is a build, and a build is never felled. Two trees grown
//               into each other are split by OWNERSHIP: every cell goes to the FOOT it is nearest to, counted in
//               steps through the wood (and the foliage in steps through the foliage), never by a box.
//   bodyOf      the rigid body: the cells in the frame of the fall (forward / sideways / up), the mass, the centre of
//               mass and the moment of inertia about the hinge — the numbers the physics (./rigid.ts) integrates.
//   cellAt      where one cell of the body is, in the world, at angle `angle`.
//   encode/decodeShape  the body as a short string, so the browser draws the same blocks the server is simulating.

/** The mass of one cell, by kind. Wood is the weight; the foliage only adds reach. */
export const MASS = Object.freeze({ log: 1, leaf: 0.25 });

// The limits come in two kinds, and keeping them apart is the point.
//
// The WIRE limits are the shape of `encodeShape` below: one character per coordinate. They are not a rule about trees,
// they are the size of a field, and a cell outside them simply cannot be drawn — so the flood never takes one.
//
// The SIZE limits are the real policy: how big ONE tree may be. They are DEFAULTS; the server passes its own
// (`opts.maxCells` / `opts.maxWood`, which the mod reads from the game rule `derrubada:tamanho_max`), so a server that
// wants the giant trees of some mod just raises the number. They are deliberately generous — a tree that fits in a
// screen should always fall — and when a tree is bigger still, nothing silently does nothing: the foliage is taken as
// far as the budget reaches (`capped`) and only wood beyond the cap refuses, with a reason the player is told.
export const LIMITS = Object.freeze({
  // ---- the wire
  height: 47, // u fits one character of the wire alphabet
  horizontal: 24, // |dx|, |dz| from the cut: f and s are written with an offset of 32, so they must stay inside it
  palette: 32, // distinct block names in one body (the palette index shares its character with the wood/foliage bit)
  // ---- the size of a tree
  cells: 1200, // wood + foliage of ONE tree
  wood: 400, // cells of trunk, branch and root of ONE tree
  component: 8000, // connected natural wood the flood may walk at all: past this we do not know what we are holding
  foliageReach: 6, // steps of foliage out from the wood
  footSpan: 2, // cells above the cut that still count as the SAME foot (a flare, a buttress, a 2x2 trunk)
  standing: 3, // wood cells tall: what makes a BARE trunk (a dead tree) a tree even with no foliage at all
});

/** How far the wood's centre has to hang off the stump before the tree falls that way instead of away from the cutter. */
export const LEAN = 1.2;

const KEY = (x, y, z) => `${x},${y},${z}`;
/** The 26 neighbours: wood joins its diagonal (a branch leaves the trunk cornerwise, a palm steps sideways as it rises). */
const AROUND = [];
for (let x = -1; x <= 1; x++) for (let y = -1; y <= 1; y++) for (let z = -1; z <= 1; z++) if (x || y || z) AROUND.push([x, y, z]);

const OURS = 0, FOREIGN = -1;

/**
 * The tree whose foot was just cut at `base`, or null when this is not one.
 *
 * `kinds`: `isLog(name)`, `isLeaf(name)` and `isNatural(pos, name, world)` — the three questions the mod answers from
 * the registries and from the world (a natural trunk block is natural by construction; a plain log only when the cell
 * was never edited). `world`: `getBlock(pos)`.
 *
 * `opts.maxCells` / `opts.maxWood` raise or lower the per-tree caps (the game rule). `opts.report`, when given, is
 * filled in: `reason` ('nao-e-arvore' | 'grande-demais') when the answer is null, and `capped` when the foliage was
 * cut short by the budget — the caller turns that into a line for the player instead of a tree that just stands there.
 *
 * @param {{ getBlock(pos: any): string | null }} world
 * @param {{ x: number, y: number, z: number }} base
 * @param {{ isLog(name: string): boolean, isLeaf(name: string): boolean, isNatural(pos: any, name: string, world: any): boolean }} kinds
 * @param {{ maxCells?: number, maxWood?: number, report?: any }} [options]
 */
export function findTree(world, base, kinds, options) {
  const opts = options ?? {};
  const report = opts.report ?? {};
  report.reason = null;
  report.capped = false;
  const maxCells = Math.max(1, opts.maxCells ?? LIMITS.cells);
  const maxWood = Math.max(1, opts.maxWood ?? Math.min(LIMITS.wood, Math.round(maxCells / 3)));

  const isWood = (p, block) => !!block && kinds.isLog(block) && kinds.isNatural(p, block, world);
  // the wire's box, and nothing else: no rule about how wide or how crooked a tree may be lives here
  const drawable = (p) => Math.abs(p.x - base.x) <= LIMITS.horizontal && Math.abs(p.z - base.z) <= LIMITS.horizontal
    && p.y >= base.y && p.y - base.y <= LIMITS.height;

  // ---- (1) the connected natural wood from the cut: ANY shape, up and sideways, never below the cut (the roots stay).
  const component = new Map();
  {
    const cut = world.getBlock(base);
    if (!isWood(base, cut)) { report.reason = 'nao-e-arvore'; return null; }
    const queue = [base], seen = new Set([KEY(base.x, base.y, base.z)]);
    component.set(KEY(base.x, base.y, base.z), { x: base.x, y: base.y, z: base.z, block: cut });
    while (queue.length) {
      const at = queue.shift();
      for (const [dx, dy, dz] of AROUND) {
        const p = { x: at.x + dx, y: at.y + dy, z: at.z + dz }, key = KEY(p.x, p.y, p.z);
        if (seen.has(key) || !drawable(p)) continue;
        seen.add(key);
        const block = world.getBlock(p);
        if (!isWood(p, block)) continue;
        component.set(key, { x: p.x, y: p.y, z: p.z, block });
        if (component.size > LIMITS.component) { report.reason = 'grande-demais'; return null; }
        queue.push(p);
      }
    }
  }

  // ---- (2) the FEET of that wood: its cells in the bottom band, grouped by touch. A 2x2 trunk, a flare of buttress
  //      roots or a forked stump is ONE foot; the tree next door, whose branches grew into ours up in the air, is
  //      ANOTHER foot, and that is how two trees grown together are told apart without any box.
  const footOf = new Map(); // key -> group index (0 is OURS: the group the cut belongs to)
  {
    const inBand = (c) => c.y - base.y <= LIMITS.footSpan;
    const spread = (start, group) => {
      const queue = [start];
      footOf.set(KEY(start.x, start.y, start.z), group);
      while (queue.length) {
        const at = queue.shift();
        for (const [dx, dy, dz] of AROUND) {
          const key = KEY(at.x + dx, at.y + dy, at.z + dz), c = component.get(key);
          if (!c || !inBand(c) || footOf.has(key)) continue;
          footOf.set(key, group);
          queue.push(c);
        }
      }
    };
    spread(base, OURS); // ours first, so group 0 is always the cut's own foot
    let group = 1;
    for (const c of component.values()) if (inBand(c) && !footOf.has(KEY(c.x, c.y, c.z))) spread(c, group++);
  }

  // ---- (3) OWNERSHIP of the wood: every cell goes to the foot it is nearest to, counted in STEPS THROUGH THE WOOD.
  //      One breadth-first walk from every foot at once, ours enqueued first so a tie is ours. This is what replaces
  //      the old "nothing beyond N blocks of the cut": a branch fifteen cells out is ours while no other trunk is a
  //      shorter walk away, and the neighbour's trunk is never ours because the neighbour's own foot is right under it.
  const owner = new Map();
  {
    const queue = [];
    for (const [key, group] of footOf) { owner.set(key, group); queue.push(component.get(key)); }
    queue.sort((a, b) => (footOf.get(KEY(a.x, a.y, a.z)) ?? 0) - (footOf.get(KEY(b.x, b.y, b.z)) ?? 0));
    for (let head = 0; head < queue.length; head++) {
      const at = queue[head], mine = owner.get(KEY(at.x, at.y, at.z));
      for (const [dx, dy, dz] of AROUND) {
        const key = KEY(at.x + dx, at.y + dy, at.z + dz), c = component.get(key);
        if (!c || owner.has(key)) continue;
        owner.set(key, mine);
        queue.push(c);
      }
    }
  }
  // The CUT CELL itself is not part of the body: the game already broke it and dropped it, as it does any block. It is
  // only the seed of the flood and the anchor of the foot — the body starts one cell above the stump.
  const cutKey = KEY(base.x, base.y, base.z);
  const wood = [], foreignWood = [];
  for (const [key, c] of component) {
    if (key === cutKey) continue;
    (owner.get(key) === OURS ? wood : foreignWood).push(c);
  }
  if (!wood.length) { report.reason = 'nao-e-arvore'; return null; }
  if (wood.length > maxWood) { report.reason = 'grande-demais'; return null; }

  // ---- (4) the FOLIAGE. Out from our wood, step by step, and a cell is ours only while no FOREIGN wood is a shorter
  //      walk away — the walk measured through the foliage itself, not as a box around a trunk. Foreign wood is both
  //      the neighbour inside the same clump of wood (3) and any wood standing around us that the flood never joined
  //      (an unconnected tree, a cabin the player built): either way, that trunk owns the leaves nearest to it.
  const foliage = [];
  {
    const mark = new Map();
    const queue = [];
    // the stump the axe cut is ours too: it is not part of the body, but it is our wood, and a leaf touching it is ours
    for (const c of [component.get(cutKey), ...wood]) { mark.set(KEY(c.x, c.y, c.z), OURS); queue.push(c); }
    for (const c of foreignWood) { mark.set(KEY(c.x, c.y, c.z), FOREIGN); queue.push(c); }
    for (const c of standingWoodAround(world, kinds, wood, mark)) { mark.set(KEY(c.x, c.y, c.z), FOREIGN); queue.push(c); }
    let edge = queue;
    for (let step = 1; step <= LIMITS.foliageReach && edge.length; step++) {
      const next = [];
      for (const at of edge) {
        const mine = mark.get(KEY(at.x, at.y, at.z));
        for (const [dx, dy, dz] of AROUND) {
          const p = { x: at.x + dx, y: at.y + dy, z: at.z + dz }, key = KEY(p.x, p.y, p.z);
          if (mark.has(key) || !drawable(p)) continue;
          const block = world.getBlock(p);
          if (!block || !kinds.isLeaf(block) || !kinds.isNatural(p, block, world)) continue;
          mark.set(key, mine);
          next.push({ x: p.x, y: p.y, z: p.z, block });
          if (mine !== OURS) continue;
          // the budget: over it the tree still falls, with the canopy it managed to take (never "nothing happens")
          if (wood.length + foliage.length >= maxCells) { report.capped = true; continue; }
          foliage.push({ x: p.x, y: p.y, z: p.z, block });
        }
      }
      edge = next;
    }
  }

  // ---- (5) is it a tree at all? Foliage says yes. With NO foliage, only a trunk that STANDS does — which is what
  //      lets the bare dead trees of a marsh fall, while a log lying on the ground or a single stump does not.
  const tall = wood.reduce((m, c) => Math.max(m, c.y - base.y + 1), 0);
  if (!foliage.length && tall < LIMITS.standing) { report.reason = 'nao-e-arvore'; return null; }

  // ---- (6) the palette has to fit on the wire; past it the body could not be drawn at all
  const names = new Set();
  for (const c of wood) names.add(c.block);
  for (const c of foliage) names.add(c.block);
  if (names.size > LIMITS.palette) { report.reason = 'grande-demais'; return null; }

  report.capped = !!report.capped;
  return { logs: wood, leaves: foliage, capped: report.capped };
}

/**
 * Wood standing around this tree that the flood never joined: the unconnected trunk of a neighbour, the wall of a
 * cabin. One pass over the box that can hold a cell within `foliageReach` of foliage of ours, so step (4) above costs
 * no extra reads. Natural or built makes no difference here: either way that trunk owns the foliage nearest to it.
 */
function standingWoodAround(world, kinds, wood, known) {
  let x0 = wood[0].x, x1 = x0, z0 = wood[0].z, z1 = z0, y0 = wood[0].y, y1 = y0;
  for (const c of wood) {
    if (c.x < x0) x0 = c.x; if (c.x > x1) x1 = c.x;
    if (c.z < z0) z0 = c.z; if (c.z > z1) z1 = c.z;
    if (c.y < y0) y0 = c.y; if (c.y > y1) y1 = c.y;
  }
  const r = LIMITS.foliageReach;
  const out = [];
  // one cell below the tree's own floor is as low as this looks: our foliage never hangs under the cut (the wire has
  // no room for it), so a trunk further down than that can own none of it
  for (let x = x0 - r; x <= x1 + r; x++) for (let z = z0 - r; z <= z1 + r; z++) for (let y = y0 - 1; y <= y1 + r; y++) {
    const key = KEY(x, y, z);
    if (known.has(key)) continue;
    const block = world.getBlock({ x, y, z });
    if (block && kinds.isLog(block)) out.push({ x, y, z, block });
  }
  return out;
}

/** Where the wood's weight hangs, in cells, relative to the cut: what a leaning tree falls towards. */
export function leanOf(base, tree) {
  const wood = tree?.logs;
  if (!wood?.length) return { x: 0, z: 0 };
  let x = 0, z = 0;
  for (const c of wood) { x += c.x - base.x; z += c.z - base.z; }
  return { x: x / wood.length, z: z / wood.length };
}

/**
 * Which way the tree goes over. A tree that LEANS falls the way it leans — the weight is already out there, and a
 * palm that grew out over the water does not tip back up the beach because of where the woodcutter stood. A tree whose
 * weight sits over its own stump has no such preference, and then it falls AWAY from whoever cut it, along the nearer
 * axis, as it always did.
 */
export function fallDirection(base, from, tree = null) {
  const lean = leanOf(base, tree);
  if (Math.abs(lean.x) >= LEAN || Math.abs(lean.z) >= LEAN) {
    if (Math.abs(lean.x) >= Math.abs(lean.z)) return { x: lean.x >= 0 ? 1 : -1, z: 0 };
    return { x: 0, z: lean.z >= 0 ? 1 : -1 };
  }
  const dx = base.x + 0.5 - from.x, dz = base.z + 0.5 - from.z;
  if (Math.abs(dx) >= Math.abs(dz)) return { x: dx >= 0 ? 1 : -1, z: 0 };
  return { x: 0, z: dz >= 0 ? 1 : -1 };
}

/** Only an axe fells; any other tool (or a bare hand) breaks the one block, as always. */
export const isAxe = (name) => typeof name === 'string' && name.endsWith('_axe');

/**
 * Is `base` the FOOT of its wood? Not just "nothing straight below": a trunk that curves (a palm steps sideways as it
 * rises, and doubles the cell of the step so it stays connected) has cells whose own column is air, and cutting one of
 * those used to take the top half of the palm away. The foot is the cell with no wood in the NINE cells under it.
 * @param {{ getBlock(pos: any): string | null }} world
 */
export function isFoot(world, pos, kinds) {
  for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
    const p = { x: pos.x + dx, y: pos.y - 1, z: pos.z + dz };
    const block = world.getBlock(p);
    if (block && kinds.isLog(block) && kinds.isNatural(p, block, world)) return false;
  }
  return true;
}

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
