// @ts-check
// THE ADAPTER between this feature and the WORLD MODIFIERS of the create-world screen ("Modificadores").
//
// The switch itself is a GAME RULE (`derrubada:arvores`, boolean, default ON): the server saves it in the world, an
// admin flips it with `/gamerule`, and everything in the mod asks only `rules.get(...)`. That is on purpose — the rule
// is the mechanism, the modifier is just the name a player chooses it by on the create-world screen.
//
// `ctx.modifiers` landed (docs/modding.md §47), so wiring this feature into it is the ONE call below and nothing else:
// each modifier declares, in `gamerules`, the value it forces on the rule it drives WHEN IT IS OFF. The rule stays the
// mechanism and `/gamerule` keeps working; the modifier is the name a player chooses it by when the world is born.
// On an engine without the registry this function finds nothing and does nothing, which is exactly what a mod loaded on
// an older server should do.

export const FELL_RULE = 'arvores';
export const CRUSH_RULE = 'dano_arvore';

/** `Derrubada de árvores` as a world modifier, when the running engine has the registry for one. */
export function registerFellingModifier(ctx) {
  const registry = /** @type {any} */ (ctx).modifiers;
  if (!registry?.register) return false;
  const felling = registry.register('derrubada_arvores', {
    name: 'Derrubada de árvores',
    description: 'Cortar o pé de uma árvore com um machado derruba a árvore inteira, que tomba com peso e física.',
    category: 'fisica',
    order: 0,
    default: true,
    gamerules: { false: { [`derrubada:${FELL_RULE}`]: false } },
  });
  // the damage is a CHILD of the felling: a tree that never falls cannot crush anybody, so with the one above off this
  // one stops by itself and the create-world screen draws it indented and greyed
  registry.register('derrubada_dano', {
    name: 'Árvore caída machuca',
    description: 'Quem for pego embaixo de uma árvore que tomba se machuca.',
    category: 'fisica',
    order: 1,
    parent: felling,
    default: true,
    gamerules: { false: { [`derrubada:${CRUSH_RULE}`]: false } },
  });
  return true;
}
