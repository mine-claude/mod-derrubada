// @ts-check
// DERRUBADA — cut the foot of a tree with an axe and the WHOLE tree tips over, as one rigid body with weight.
//
//   tree.ts     which cells are the tree, and the geometry of the fall (pure)
//   rigid.ts    the body: the gravity torque on the hinge at the stump, contact, bounce, rest (pure)
//   felling.ts  the server: detach in one tick, one entity, 20 Hz, drops at rest
//   render.ts   the browser: one merged mesh, interpolated between two angles
//   modifier.ts the one call that turns the game rule into a world modifier when the engine has them
//
// This file only wires those together, and everything it needs it READS FROM THE REGISTRIES, never by name. NOTHING
// here knows the SHAPE of a tree — no straight trunk, no crown on top, no box around the cut (see ./tree.ts). What a
// tree is MADE OF is DECLARED by content, in four ways, and any of them is enough:
//   - a block that declares `trunk` (a natural trunk) is WOOD, and so is the plain log it grows from;
//   - the conventional tag `c:logs` is WOOD and `c:leaves` is FOLIAGE (the tags the base game already uses);
//   - the tag `c:tree_foliage` is FOLIAGE that is not a leaf: a frond, a coconut, hanging moss, a mushroom's gills —
//     everything that grew on a tree and comes down with it, without having to claim the engine's `c:leaves` role
//     (which also decides where mobs spawn and how the mesher draws a pane);
//   - the registry `derrubada:trees` (`ctx.registries`), for a mod that wants to say it in one place and add a cap of
//     its own: `ctx.registries.register('derrubada:trees', 'minha_arvore', { wood: [...], foliage: [...] })`.
// And a cell is NATURAL when it is a natural trunk (no player can place one: those blocks have no item) or when the
// world says the cell was never edited. That is what keeps a cabin built of logs from being felled.
// Every set is read on the first fell, not at boot, so a mod that loads after this one still counts.
import { MobType, ModInitializer } from './mineclaude-sdk.js';
import { createFelling, crushDamage, CRUSH_SCAN, MAX_FALLING } from './felling.ts';
import { createTreeStore, treeRendererFor } from './render.ts';
import { CRUSH_RULE, FELL_RULE, registerFellingModifier } from './modifier.ts';
import { isAxe, isFoot, LIMITS } from './tree.ts';

const STEP = 0.05; // s: the server's own tick, and the rate the body is integrated and sent at
export const LOGS_TAG = 'c:logs';
const LEAVES_TAG = 'c:leaves';
/** Foliage that is not a leaf: a frond, a coconut, hanging moss, the gills of a mushroom. */
export const FOLIAGE_TAG = 'c:tree_foliage';
/** The registry any mod may declare a tree in, without depending on this one being loaded first. */
export const TREES_REGISTRY = 'trees';
export const SIZE_RULE = 'tamanho_max';
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
    // How big ONE tree may be, in cells. The cap is a RULE and not a constant on purpose: a mod whose trees are
    // giants only needs the server's owner to raise this, and nothing in the code has to know about that mod.
    ctx.rules.register(SIZE_RULE, {
      type: 'integer', default: LIMITS.cells, min: 8, max: LIMITS.component, category: 'mundo',
      name: 'Tamanho máximo da árvore derrubada',
      description: 'Quantas células (troncos + folhagem) uma árvore pode ter para tombar inteira. Acima disso o machado só quebra o bloco.',
    });
    registerFellingModifier(ctx);
    // The hook other mods declare their trees in. Created here, read on the first fell: a mod that loads later still
    // counts, and a mod that loads EARLIER reaches it through `ctx.tags` instead, which needs no registry at all.
    /** @type {any} */ let trees = null;
    try { trees = /** @type {any} */ (ctx).registries?.create?.(TREES_REGISTRY); } catch { /* an engine without mod registries: the tags alone */ }

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
      leaves = new Set([...ctx.tags.values('block', LEAVES_TAG), ...ctx.tags.values('block', FOLIAGE_TAG)]);
      // and what the mods declared in the registry: the same two sets, said in one place
      for (const entry of declaredTrees()) {
        for (const block of entry.wood ?? []) logs.add(block);
        for (const block of entry.foliage ?? entry.leaves ?? []) leaves.add(block);
      }
    };
    /** The entries of `derrubada:trees`, read defensively: a bad entry from another mod never costs the fall. */
    const declaredTrees = () => {
      try {
        const list = (trees ?? /** @type {any} */ (ctx).registries?.get?.(`derrubada:${TREES_REGISTRY}`))?.list?.() ?? [];
        return list.map((e) => /** @type {any} */ (e.value)).filter((v) => v && typeof v === 'object');
      } catch { return []; }
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
      maxCells: () => {
        const rule = Number(ctx.rules.get(SIZE_RULE));
        const declared = declaredTrees().reduce((m, e) => Math.max(m, Number(e.maxCells) || 0), 0);
        return Math.max(Number.isFinite(rule) && rule > 0 ? rule : LIMITS.cells, Math.min(declared, LIMITS.component));
      },
    };
    const felling = createFelling(ctx, kinds, names, { creak, crash, leafParticle });
    live = felling;

    const say = (player, text) => { try { player.message(text); } catch { /* the player left mid-chop */ } };

    /**
     * The one decision: does this break fell a tree? And when it does not, the player HEARS WHY — a tree that just
     * stands there after a chop at its foot is the bug the owner reported twice, and silence is half of it.
     */
    const tryFell = (world, pos, player, held) => {
      if (ctx.rules.get(FELL_RULE) === false) return null; // the modifier is off: a normal break
      if (!isAxe(held)) return null; // a bare hand (or a pickaxe) breaks the one block, as always
      const block = world.getBlock(pos);
      if (!block || !kinds.isLog(block) || !kinds.isNatural(pos, block, world)) return null;
      // Only the FOOT of a tree, and the foot is the cell with no wood in the NINE under it: a trunk that CURVES (a
      // palm steps sideways as it rises) has cells whose own column is air, and asking only straight down used to
      // fell the top half of the palm from the middle of its trunk.
      if (!isFoot(world, pos, kinds)) return null;
      const fall = felling.fell(world, pos, player);
      if (!fall) {
        const why = felling.report.reason;
        if (why === 'grande-demais') say(player, 'Esta árvore é grande demais para tombar inteira — o machado quebra bloco por bloco.');
        else if (why === 'cheio') say(player, 'Muitas árvores caindo ao mesmo tempo. Tente de novo em um instante.');
      } else if (felling.report.capped) {
        say(player, 'A copa é maior que o limite do mundo: a árvore tombou com parte da folhagem.');
      }
      return fall;
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
    if (ctx.config.get('comandos_de_teste') === true) this.commands(ctx, felling, tryFell, kinds);
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
  commands(ctx, felling, tryFell, kinds) {
    let at = null;
    const W = (e) => ctx.dimensions.world(e.player.dimension); // `prepare` / `topBlock` from the dimension's world
    const P = (dx, dy, dz) => ({ x: at.x + dx, y: at.y + dy, z: at.z + dz });
    // the same world, but every read LOADS the chunk: a scan has to see the same cells every run, not whichever
    // chunks happen to be in memory
    const loaded = (w) => ({ getBlock: (q) => w.getBlock(q, { load: true }), blockEdited: (q) => w.blockEdited(q) });
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
              // the same question the real cut asks (./tree.ts isFoot): no wood in the NINE cells below, so a cell in
              // the middle of a trunk that curves is never taken for a foot
              if (!isFoot(loaded(w), { x, y, z }, kinds)) continue;
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
          crush: fall ? crushDamage(fall.body.mass) : 0, maxWood: LIMITS.wood, maxFalling: MAX_FALLING,
          reason: felling.report.reason, capped: felling.report.capped,
          dir: fall ? `${fall.body.direction.x},${fall.body.direction.z}` : null,
        })}`);
      },
    });
    // ---- the trees of the OTHER mods, by the block their foot is made of. `/arv_achar` above looks for a tree of any
    // kind big enough to film; this one looks for ONE SHAPE — the ipê that twists, the palm that curves out over the
    // water, the bare dead trunk of the marsh — which is what the suite walks through, one style per scenario.
    ctx.commands.register('arv_tronco', {
      admin: true,
      help: '/arv_tronco <bloco> [x] [z] [raio] — acha o pé de uma árvore DESSE bloco perto da coluna, leva o jogador até ela e diz o que um corte levaria',
      run(e) {
        const w = W(e), p = e.player.pos;
        const want = String(e.args[0] ?? '');
        const px = e.args[1] === undefined ? Math.floor(p.x) : Number(e.args[1]);
        const pz = e.args[2] === undefined ? Math.floor(p.z) : Number(e.args[2]);
        const radius = Math.min(48, Math.max(2, Number(e.args[3] ?? 12)));
        at = null;
        let best = null;
        for (let r = 0; r <= radius && !best; r++) {
          const ring = r === 0 ? [[px, pz]] : [];
          for (let i = -r; i <= r && r > 0; i++) ring.push([px + i, pz - r], [px + i, pz + r], [px - r, pz + i], [px + r, pz + i]);
          for (const [x, z] of ring) {
            const top = w.topBlock({ x, z });
            if (top < 2) continue;
            for (let y = top + 2; y > top - 20 && y > 2; y--) {
              const here = w.getBlock({ x, y, z }, { load: true });
              if (here !== want) continue;
              const foot = { x, y, z }, view = loaded(w);
              if (!isFoot(view, foot, kinds)) continue;
              const report = {};
              const dry = felling.inspect(view, foot, report);
              best = { foot, dry, report };
              break;
            }
            if (best) break;
          }
        }
        if (!best) return e.reply('arv {"found":false}');
        at = best.foot;
        e.player.teleport({ x: at.x - 2.5, y: at.y + 1, z: at.z + 0.5 });
        return e.reply(`arv ${JSON.stringify({
          found: true, x: at.x, y: at.y, z: at.z, block: want,
          logs: best.dry?.logs.length ?? 0, leaves: best.dry?.leaves.length ?? 0,
          reason: best.report.reason ?? null, capped: !!best.report.capped,
        })}`);
      },
    });
  }
}
