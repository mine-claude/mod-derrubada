// @ts-check
// TREE FELLING, part 3 of 3: the SERVER. It owns the fall; the browser only draws what this sends.
//
// The cut of the foot of a tree with an axe turns the whole tree into ONE entity:
//   1. findTree (./tree.ts) floods the connected natural tree from the cut log, with caps;
//   2. every cell of it leaves the world in the SAME TICK (batches of 64, the engine's atomic write), so no one ever
//      sees half a tree and nothing else runs in between;
//   3. one mob is spawned on the stump as the body's anchor — position fixed, gravity 0, `npc` (it takes no damage and
//      counts in no spawn cap) — and the SHAPE goes to everyone nearby as one short string;
//   4. the rigid body (./rigid.ts) is integrated at the server's own 20 Hz and the ANGLE goes out each step, one
//      message per tree in the air; the browsers interpolate between two angles. No per-block update, ever;
//   5. at rest the logs become items where they lie, the leaves burst into particles (with the leaves' own apple
//      chance), the crash is heard and the entity goes.
//
// A FUTURE OPTION, deliberately not taken yet: leaving the tree LYING as blocks, to be chopped where it fell. It is
// one branch in `settle` (write the cells back instead of dropping them) and no change anywhere else.

import { bodyOf, cellAt, encodeShape, fallDirection, findTree, LIMITS } from './tree.ts';
import { FLAT, startFall, stepFall } from './rigid.ts';

const STEP = 0.05; // s — the server's own tick: the 20 Hz the body is integrated at
const BATCH = 64; // the engine's atomic setBlocks
export const MAX_FALLING = 6; // trees in the air at once, server-wide
const HEAR = 28; // blocks: who hears the creak and the crash
const WATCH = 64; // blocks: who gets the shape and the angles
export const CRUSH_BASE = 4; // the damage of being under the trunk, plus the tree's mass
const CRUSH_PER_MASS = 0.4;
const CRUSH_MAX = 20;
// blocks: how far around the stump the entity asks the engine for the mobs that could be under the fall. A radius is
// REQUIRED by `mobsNear` (0..64) — asking without one threw on every ai tick of every fall, so no mob was ever hurt.
// The longest tree the caps allow lies down well inside this.
export const CRUSH_SCAN = 32;

/** How much being hit by this tree costs. */
export const crushDamage = (mass) => Math.min(CRUSH_MAX, Math.round(CRUSH_BASE + mass * CRUSH_PER_MASS));

/**
 * The felling runtime. `kinds` answers what a log, a leaf and a natural cell are (`isLog`, `isLeaf`, `isNatural`,
 * `air`); `names` maps a log block to the item it drops, a leaf block to its chance drop and holds the entity's name;
 * `sounds` holds the two sound names and the leaf particle. All of them are read from the registries once, at boot.
 */
export function createFelling(ctx, kinds, names, sounds) {
  /** @type {Map<number, any>} */ const falls = new Map();
  let done = null; // the last tree that landed: what it dropped and burst
  /** Why the LAST attempt found no tree ('nao-e-arvore' | 'grande-demais'), and whether the canopy was cut short. */
  let report = { reason: null, capped: false };

  const nearby = (pos) => { try { return ctx.server.playersNear(pos, WATCH); } catch { return []; } };

  /** The per-tree caps of this server: the game rule, not a constant (see ./main.ts SIZE_RULE). */
  const sizeOpts = () => {
    const cells = names.maxCells?.() ?? LIMITS.cells;
    return { maxCells: cells, maxWood: Math.max(1, Math.min(LIMITS.wood, Math.round(cells / 3))), report };
  };

  /** The cut of a tree's foot: the whole tree becomes one body. Returns the fall, or null when nothing was felled. */
  function fell(world, base, cutter) {
    report = { reason: null, capped: false };
    if (falls.size >= MAX_FALLING) { report.reason = 'cheio'; return null; }
    const tree = findTree(world, base, kinds, sizeOpts());
    if (!tree) return null;
    const body = bodyOf(base, fallDirection(base, cutter.pos, tree), tree);
    // (2) the whole tree leaves the world in this tick, in batches of the engine's atomic write. Nothing else runs
    // between them (one tick, one thread), so no one ever sees half a tree.
    const cells = [...tree.logs, ...tree.leaves];
    let cleared = 0;
    for (let i = 0; i < cells.length; i += BATCH) {
      const batch = cells.slice(i, i + BATCH).map((c) => ({ pos: { x: c.x, y: c.y, z: c.z }, block: kinds.air }));
      if (world.setBlocks(batch)) cleared += batch.length;
    }
    const live = { body, fall: startFall(body), world, mob: null, id: 0, hurt: new Set(), mobsNear: [], dropped: 0, burst: 0, cleared, cells: cells.length, shape: encodeShape(body) };
    // (3) the anchor entity, pinned on the stump
    const mob = world.spawnMob({ x: base.x + 0.5, y: base.y, z: base.z + 0.5 }, names.mob);
    if (!mob) { // no room for an entity: the tree still comes down, it just does it in this tick
      live.fall.angle = FLAT;
      settle(live);
      return null;
    }
    mob.setPosition(base.x + 0.5, base.y, base.z + 0.5);
    mob.setHealthBar(false);
    mob.setFlags({ noKnockback: true, immortal: true });
    live.mob = mob;
    live.id = mob.id;
    falls.set(mob.id, live);
    for (const p of nearby(base)) sendShape(p, live);
    try {
      ctx.server.playSound(sounds.creak, { x: base.x + 0.5, y: base.y + 1, z: base.z + 0.5 }, { radius: HEAR });
    } catch { /* a missing sound never costs the fall */ }
    return live;
  }

  function sendShape(player, live) {
    try {
      ctx.net.send(player, 'shape', {
        id: live.id, x: live.body.base.x, y: live.body.base.y, z: live.body.base.z,
        dx: live.body.direction.x, dz: live.body.direction.z, pal: live.body.palette, cells: live.shape,
      });
    } catch { /* over the budget, or the player left: the browser asks again */ }
  }

  /** Who is standing in a cell the trunk now fills: the players nearby and the mobs the engine handed the entity. */
  function crush(live) {
    if (!names.crushOn()) return;
    const filled = new Set();
    for (const cell of live.body.cells) {
      if (!cell.log) continue;
      const p = cellAt(live.body, cell, live.fall.angle);
      filled.add(`${p.x},${p.y},${p.z}`);
    }
    if (!filled.size) return;
    const inside = (pos) => filled.has(`${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}`)
      || filled.has(`${Math.floor(pos.x)},${Math.floor(pos.y + 1)},${Math.floor(pos.z)}`);
    const damage = crushDamage(live.body.mass);
    for (const p of nearby(live.body.base)) {
      if (live.hurt.has(p.name) || !inside(p.pos)) continue;
      live.hurt.add(p.name);
      try { p.damage(damage); } catch { /* the player left mid-fall */ }
    }
    for (const m of live.mobsNear) {
      const key = `mob:${m.id}`;
      if (live.hurt.has(key) || !inside(m.pos)) continue;
      live.hurt.add(key);
      try { m.damage(damage); } catch { /* gone */ }
    }
  }

  const centre = (pos) => ({ x: pos.x + 0.5, y: pos.y + 0.5, z: pos.z + 0.5 });

  function burstLeaf(live, pos, block) {
    live.burst++;
    const at = centre(pos);
    try { live.world.spawnParticles(sounds.leafParticle, at, { count: 6, block }); } catch { /* never fatal */ }
    const chance = names.leafChance(block);
    if (chance && Math.random() < chance.chance) live.world.dropItem(at, chance.item, 1);
  }

  /** (5) At rest: every log still in the body is an item where it lies, every leaf bursts, the crash is heard. */
  function settle(live) {
    const { body, fall } = live;
    for (const cell of body.cells) {
      const pos = cellAt(body, cell, fall.angle);
      if (cell.log) { live.dropped++; live.world.dropItem(centre(pos), names.logItem(body.palette[cell.block]), 1); }
      else burstLeaf(live, pos, body.palette[cell.block]);
    }
    body.cells = [];
    try {
      ctx.server.playSound(sounds.crash, { x: body.base.x + 0.5, y: body.base.y + 1, z: body.base.z + 0.5 }, { radius: HEAR });
    } catch { /* no sound is worth losing the drops over */ }
  }

  /** One step of every tree in the air. Called at 20 Hz by the mod's runtime scope. */
  function tick(dt = STEP) {
    if (!falls.size) return;
    for (const live of [...falls.values()]) {
      const world = live.world;
      const result = stepFall(live.fall, dt, { solid: (pos) => world.isSolid(pos) !== false });
      for (const b of live.fall.broken) burstLeaf(live, b.pos, live.body.palette[b.cell.block]); // a leaf breaks where it hit
      crush(live);
      if (result === 'resting') {
        settle(live);
        falls.delete(live.id);
        done = live; // what the last tree to land left behind, for the suite and for `/arv_estado`
        try { live.mob?.remove(); } catch { /* already gone */ }
        continue;
      }
      // (4) one message per tree per step: the angle, in hundredths of a radian
      const pose = { id: live.id, a: Math.round(live.fall.angle * 100) };
      for (const p of nearby(live.body.base)) {
        try { ctx.net.send(p, 'pose', pose); } catch { /* over budget: the next step carries the angle anyway */ }
      }
    }
  }

  return {
    fell,
    tick,
    falls,
    /** The last tree that came to rest (what it dropped and burst). */
    get done() { return done; },
    /** What the registries say, for a command or another mod that wants the same answers. */
    isLog: (name) => kinds.isLog(name),
    isLeaf: (name) => kinds.isLeaf(name),
    plainLogOf: (block) => names.logItem(block),
    /** The tree a cut here WOULD take, without taking it. `into` is filled with the reason when the answer is null. */
    inspect: (world, base, into = {}) => findTree(world, base, kinds, { ...sizeOpts(), report: into }),
    /** Why the last attempt took no tree, and whether the canopy it did take was cut short by the budget. */
    get report() { return report; },
    /** The entity's `ai`: it decides nothing (it is a tree) — it only takes the mob list the engine hands it. */
    recordMobs(id, mobs) { const live = falls.get(id); if (live) live.mobsNear = mobs ?? []; return null; },
    /** A browser that saw a tree it has no shape for asks here. */
    resend(player, id) { const live = falls.get(id); if (live) sendShape(player, live); },
    limits: LIMITS,
  };
}
