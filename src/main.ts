// @ts-check
// DERRUBADA — cut the foot of a tree with an axe and the WHOLE tree tips over, as one rigid body with weight.
//
//   tree.ts     which cells are the tree, and the geometry of the fall (pure)
//   rigid.ts    the body: the gravity torque on the hinge at the stump, contact, bounce, rest (pure)
//   felling.ts  the server: detach in one tick, one entity, 20 Hz, drops at rest
//   render.ts   the browser: one merged mesh, interpolated between two angles
//   modifier.ts the one call that turns the game rule into a world modifier when the engine has them
//
// This file only wires those together, and everything it needs it READS FROM THE REGISTRIES, never by name:
//   - a LOG is a block that declares `trunk` (a natural trunk), the plain log such a block grows from, or anything in
//     the conventional `c:logs` tag (a mod whose logs grow no natural trunk just lists them there);
//   - a LEAF is anything in the conventional `c:leaves` tag;
//   - a cell is NATURAL when it is a natural trunk (no player can place one: those blocks have no item) or when the
//     world says the cell was never edited. That is what keeps a cabin built of logs from being felled.
// Both sets are read on the first fell, not at boot, so a mod that loads after this one still counts.
import { MobType, ModInitializer } from './mineclaude-sdk.js';
import { createFelling, crushDamage, CRUSH_SCAN, MAX_FALLING } from './felling.ts';
import { createTreeStore, treeRendererFor } from './render.ts';
import { CRUSH_RULE, FELL_RULE, registerFellingModifier } from './modifier.ts';
import { isAxe, LIMITS } from './tree.ts';

const STEP = 0.05; // s: the server's own tick, and the rate the body is integrated and sent at
export const LOGS_TAG = 'c:logs';
const LEAVES_TAG = 'c:leaves';
const AIR = 'mineclaude:air';
const MOB = 'derrubada:tronco_caindo';

/** The running felling, for the entity's `ai` below (a class field cannot see the context). */
let live = null;

/**
 * The anchor entity of a falling tree: it stands still, floats, takes no damage and counts in no spawn cap. Its whole
 * body is the mesh the browser builds (./render.ts); the engine only has to keep the entity where the stump is.
 * Its `ai` decides nothing — a tree has no plans. It is there for one reason: it is where the engine hands an entity
 * the mobs around it, which is how a tree knows whom it is landing on.
 */
class TroncoCaindo extends MobType {
  key = 'tronco_caindo';
  name = 'Árvore caindo';
  emoji = '🌲';
  halfW = 0.4;
  height = 1;
  /** @type {'npc'} */ behavior = 'npc';
  hp = 1;
  speed = 0;
  gravity = 0;
  aiEvery = 1;
  // `mobsNear` takes the radius it may look in; without one the engine refuses the call, and then nothing standing
  // under the tree was ever found (the ai threw on every tick of the fall instead).
  ai(e) { return live?.recordMobs(e.mob.id, e.mobsNear?.(CRUSH_SCAN)) ?? null; }
}

export default class Derrubada extends ModInitializer {
  /** @param {import('../../packages/cli/types/mineclaude-mod').ModContext} ctx */
  onInitialize(ctx) {
    // ---- both sides, in the same order: the sounds, the particle, the entity, the two switches and the tag
    const creak = ctx.sounds.synth('creak', { layers: [
      { kind: 'tone', freq: 140, end: 74, dur: 1.1, type: 'sawtooth', gain: 0.1 },
      { kind: 'noise', freq: 420, q: 7, dur: 0.9, gain: 0.05, delay: 0.05 },
      { kind: 'tone', freq: 230, end: 118, dur: 0.6, type: 'triangle', gain: 0.05, delay: 0.3 },
    ] });
    const crash = ctx.sounds.synth('crash', { layers: [
      { kind: 'noise', freq: 190, q: 1, dur: 0.55, gain: 0.3 },
      { kind: 'noise', freq: 1300, q: 2, dur: 0.22, gain: 0.12, delay: 0.03 },
      { kind: 'tone', freq: 90, end: 45, dur: 0.45, type: 'triangle', gain: 0.14 },
    ] });
    const leafParticle = ctx.particles.register('folha', {
      fromBlock: true, size: 0.1, life: 1.1, gravity: 0.35, speed: 1.6, spread: 0.9, drag: 2.4, shrink: true, collide: true, burst: 32,
    });
    ctx.mobs.register('tronco_caindo', new TroncoCaindo());
    // The game rule IS the switch; ./modifier.ts only gives it a name on the create-world screen.
    ctx.rules.register(FELL_RULE, { type: 'boolean', default: true, category: 'mundo' });
    ctx.rules.register(CRUSH_RULE, { type: 'boolean', default: true, category: 'mundo' });
    registerFellingModifier(ctx);

    if (!ctx.isServer()) { this.client(ctx); return; }

    // What the registries say a log, a leaf and a natural cell are. Read on FIRST USE, never while registering: the
    // registries are still filling then, and a mod that loads after this one would be missing from every set.
    let logs = null, leaves = null;
    const trunkOf = new Map(); // natural trunk -> the plain log it grows from
    const chanceOf = new Map(); // block -> the chance drop the block itself declares (the leaves' apple)
    const load = () => {
      if (logs) return;
      ctx.blocks.find((def, name) => {
        if (/** @type {any} */ (def)?.trunk) trunkOf.set(name, /** @type {any} */ (def).trunk.of);
        if (/** @type {any} */ (def)?.chanceDrop) chanceOf.set(name, /** @type {any} */ (def).chanceDrop);
        return false;
      });
      logs = new Set([...ctx.tags.values('block', LOGS_TAG), ...trunkOf.keys(), ...trunkOf.values()]);
      leaves = new Set(ctx.tags.values('block', LEAVES_TAG));
    };
    const kinds = {
      air: AIR,
      isLog: (name) => (load(), logs.has(name)),
      isLeaf: (name) => (load(), leaves.has(name)),
      // A natural trunk is natural by construction (it has no item: only generation places one). Anything else is
      // natural only while nobody has touched the cell — that is what spares a build made of logs and leaves.
      isNatural: (pos, name, world) => (load(), trunkOf.has(name) || world.blockEdited(pos) === false),
    };
    const names = {
      mob: MOB,
      logItem: (block) => (load(), trunkOf.get(block) ?? block),
      leafChance: (block) => (load(), chanceOf.get(block) ?? null),
      crushOn: () => ctx.rules.get(CRUSH_RULE) !== false,
    };
    const felling = createFelling(ctx, kinds, names, { creak, crash, leafParticle });
    live = felling;

    /** The one decision: does this break fell a tree? */
    const tryFell = (world, pos, player, held) => {
      if (ctx.rules.get(FELL_RULE) === false) return null; // the modifier is off: a normal break
      if (!isAxe(held)) return null; // a bare hand (or a pickaxe) breaks the one block, as always
      const block = world.getBlock(pos);
      if (!block || !kinds.isLog(block) || !kinds.isNatural(pos, block, world)) return null;
      const below = world.getBlock({ x: pos.x, y: pos.y - 1, z: pos.z });
      if (below && kinds.isLog(below)) return null; // only the FOOT of a tree, not a cut in the middle
      return felling.fell(world, pos, player);
    };

    ctx.events.on('blockBreak', (e) => {
      if (e.cancelled) return;
      tryFell(e.world, e.pos, e.player, e.player.getItem()?.item);
    });
    ctx.runtime.onStart((scope) => scope.every('queda', STEP, ({ dt }) => felling.tick(dt)));
    // A browser that came into view mid-fall and has no shape for a tree asks for it here.
    ctx.net.on('pedir', (player, d) => {
      const id = Number(/** @type {any} */ (d)?.id);
      if (Number.isInteger(id)) felling.resend(player, id);
    });
    // The scene commands below edit the world (they clear a corridor and raise a cabin), so they do NOT exist on a
    // normal server: they only appear when the server's owner turns them on in DATA_DIR/mods-config/derrubada.json
    // ({ "comandos_de_teste": true }) — which is what the suite and the browser check do. Admin even then.
    if (ctx.config.get('comandos_de_teste') === true) this.commands(ctx, felling, tryFell);
  }

  /** The browser: the store the net fills and the renderer that reads it. */
  client(ctx) {
    const store = createTreeStore();
    ctx.net.on('shape', (d) => store.shape(d));
    ctx.net.on('pose', (d) => store.pose(d));
    ctx.render.mobRenderer('tronco_caindo', treeRendererFor(store));
    /** @type {any} */ (globalThis).__derrubada = store; // the browser check reads the angles from here
  }

  /**
   * The scene the server suite and the browser check both use, off unless the owner turns it on (see the caller). It
   * cuts a REAL generated tree (`/arv_achar` looks one up in the terrain), because a natural trunk is a hidden block
   * that only generation may place — which is exactly the point of the feature: a tree is what the world grew, and a
   * build is what a player put there.
   */
  commands(ctx, felling, tryFell) {
    let at = null;
    const W = (e) => ctx.dimensions.world(e.player.dimension); // `prepare` / `topBlock` from the dimension's world
    const P = (dx, dy, dz) => ({ x: at.x + dx, y: at.y + dy, z: at.z + dz });
    ctx.commands.register('arv_achar', {
      admin: true,
      help: '/arv_achar [x] [z] — acha uma árvore gerada perto dessa coluna (ou do jogador), leva o jogador até ela e ergue uma cabana de troncos ao lado',
      run(e) {
        const w = W(e), p = e.player.pos;
        // a column given by hand makes the scan deterministic: a fixed seed plus a fixed column is always the same tree
        const px = e.args[0] === undefined ? Math.floor(p.x) : Number(e.args[0]);
        const pz = e.args[1] === undefined ? Math.floor(p.z) : Number(e.args[1]);
        at = null;
        let found = null;
        for (let r = 2; r <= 26 && !found; r++) {
          for (let i = -r; i <= r && !found; i++) for (const [x, z] of [[px + i, pz - r], [px + i, pz + r], [px - r, pz + i], [px + r, pz + i]]) {
            const top = w.topBlock({ x, z });
            if (top < 2) continue;
            for (let y = top; y > top - 14 && y > 2; y--) {
              const here = w.getBlock({ x, y, z }, { load: true });
              if (!here || !felling.isLog(here)) continue;
              const below = w.getBlock({ x, y: y - 1, z }, { load: true });
              if (below && felling.isLog(below)) continue; // not the foot of the tree
              at = { x, y, z };
              const dry = felling.inspect(w, at);
              if (dry && dry.logs.length >= 4 && dry.leaves.length >= 12) { found = { dry, log: here }; break; }
              at = null;
            }
            if (found) break;
          }
        }
        if (!found) { at = null; return e.reply('arv {"found":false}'); }
        // a clear corridor on the +x side, where the tree will fall (the player stands on the other side): the fall is
        // then the same every run, which is what the browser check films
        const mine = new Set([...found.dry.logs, ...found.dry.leaves].map((c) => `${c.x},${c.y},${c.z}`));
        for (let x = 1; x <= 15; x += 4) for (let z = -8; z <= 8; z += 8) w.prepare(P(x, 1, z));
        for (let x = 1; x <= 14; x++) for (let z = -4; z <= 4; z++) for (let y = 0; y <= 11; y++) {
          const p2 = P(x, y, z);
          if (!mine.has(`${p2.x},${p2.y},${p2.z}`)) w.setBlock(p2, AIR); // the corridor, but never a cell of the tree itself
        }
        // a BUILD of plain logs beside it: a mod wrote those cells, so the world knows they are not natural
        const plain = felling.plainLogOf(found.log);
        w.prepare(P(-6, 2, 6));
        let built = 0;
        for (let y = 0; y < 4; y++) if (w.setBlock(P(-6, y + 2, 6), plain)) built++;
        for (const [dy, dz] of [[6, 6], [6, 7], [7, 6]]) w.setBlock(P(-6, dy, dz), 'mineclaude:leaves');
        e.player.teleport({ x: at.x - 2.5, y: at.y, z: at.z + 0.5 });
        const now = felling.inspect(w, at); // after the corridor and the cabin: the tree a cut would take NOW
        return e.reply(`arv ${JSON.stringify({ found: true, x: at.x, y: at.y, z: at.z, block: found.log, logs: now.logs.length, leaves: now.leaves.length, plain, built })}`);
      },
    });
    ctx.commands.register('arv_estado', {
      admin: true,
      help: '/arv_estado — o que sobrou em volta da árvore achada e o estado da queda',
      run(e) {
        if (!at) return e.reply('arv {"found":false}');
        const w = W(e);
        let log = 0, leaf = 0;
        // `load: true`: the count must be over the same cells every time, not over whichever chunks happen to be in memory
        for (let x = -9; x <= 9; x++) for (let z = -9; z <= 9; z++) for (let y = -1; y <= 14; y++) {
          const b = w.getBlock(P(x, y, z), { load: true });
          if (!b) continue;
          if (felling.isLog(b)) log++;
          else if (felling.isLeaf(b)) leaf++;
        }
        const list = [...felling.falls.values()];
        const done = felling.done;
        return e.reply(`arv ${JSON.stringify({
          log, leaf, falling: list.length, angle: list[0] ? Math.round(list[0].fall.angle * 100) : null,
          cells: list[0]?.body.cells.length ?? null, stump: w.getBlock(P(0, 0, 0)),
          cleared: (list[0] ?? felling.done)?.cleared ?? null, took: (list[0] ?? felling.done)?.cells ?? null,
          dropped: done?.dropped ?? null, burst: done?.burst ?? null, rested: done ? Math.round(done.fall.angle * 100) : null,
        })}`);
      },
    });
    ctx.commands.register('arv_tentar', {
      admin: true,
      help: '/arv_tentar <item|mao> <dx> <dy> <dz> — tenta derrubar com esse item na mão',
      run(e) {
        if (!at) return e.reply('arv {"found":false}');
        const [item, dx, dy, dz] = e.args;
        const fall = tryFell(W(e), P(Number(dx), Number(dy), Number(dz)), e.player, item === 'mao' ? null : item);
        return e.reply(`arv ${JSON.stringify({
          felled: !!fall, cells: fall?.body.cells.length ?? 0, mass: fall ? Math.round(fall.body.mass * 100) : 0,
          crush: fall ? crushDamage(fall.body.mass) : 0, maxLogs: LIMITS.logs, maxFalling: MAX_FALLING,
        })}`);
      },
    });
  }
}
