// @ts-check
// TREE FELLING, part 2 of 3: the RIGID BODY. One tree = one body turning on the hinge at its stump, under gravity.
// Pure: it takes the body (./tree.ts) and two callbacks — `solid(pos)` (does the world bar a cell?) and
// `onLeaf(cell, pos)` (a leaf hit something) — and never touches the world itself, so the whole fall is unit-testable
// without a server.
//
// The motion is the textbook one and nothing more: the angular acceleration is the gravity torque about the hinge
// over the moment of inertia (both from the cells' masses, ./tree.ts bodyOf), integrated at the server's own 20 Hz.
// A standing tree is STABLE (its centre of mass is behind the hinge), so the cut itself gives the push: the axe blow
// is an initial angular velocity. Past the tipping angle gravity does the rest, and the tree accelerates.
//
// Contact is sampled, not solved: a cell whose world cell is barred is a contact. A leaf breaks and leaves the body;
// a log stops the turn — the tree bounces back off what it hit (restitution) and settles when the bounce is small.
// Only cells that MOVED since the last step are sampled, which is what keeps 20 Hz cheap for a 300-cell body.

import { cellAt, lever } from './tree.ts';

export const GRAVITY = 18; // blocos/s^2 — a queda do jogo é mais rápida que a da Terra, e a árvore acompanha
export const BLOW = 0.5; // rad/s: the shove the axe blow leaves on the trunk
export const RESTITUTION = 0.3; // how much of the turn comes back off what the trunk hit
export const SETTLE_OMEGA = 0.45; // rad/s: below this a bounce is over
export const MAX_BOUNCES = 2;
export const FLAT = Math.PI / 2; // lying down

/** A fresh fall of `body`, standing, with the blow of the cut already in it. */
export function startFall(body) {
  return { body, angle: 0, omega: BLOW, bounces: 0, state: 'falling', broken: [], hit: [], at: new Map() };
}

/** The angular acceleration at `angle`: the gravity torque about the hinge over the moment of inertia. */
export const alphaAt = (body, angle) => (body.mass * GRAVITY * lever(body, angle)) / body.inertia;

/**
 * One step of `dt` seconds. Fills `fall.broken` with the leaves that broke this step and `fall.hit` with the cells
 * that touched something, and returns the state ('falling', 'resting' when it came to rest this step, or 'rest').
 * @param {any} fall
 * @param {number} dt
 * @param {{ solid(pos: any): boolean, onLeaf?(cell: any, pos: any): void }} probe
 */
export function stepFall(fall, dt, probe) {
  fall.broken = [];
  fall.hit = [];
  if (fall.state === 'rest') return 'rest';
  const body = fall.body;
  const was = fall.angle;
  fall.omega += alphaAt(body, fall.angle) * dt;
  fall.angle = Math.min(FLAT, fall.angle + fall.omega * dt);
  if (fall.angle < 0) { fall.angle = 0; fall.omega = Math.max(0, fall.omega); } // never rocks back past standing
  // sample only what moved
  const kept = [];
  let blocked = false;
  for (const cell of body.cells) {
    const pos = cellAt(body, cell, fall.angle);
    const key = `${pos.x},${pos.y},${pos.z}`;
    if (fall.at.get(cell) === key) { kept.push(cell); continue; }
    if (!probe.solid(pos)) { fall.at.set(cell, key); kept.push(cell); continue; }
    if (cell.log) { blocked = true; fall.hit.push({ cell, pos }); kept.push(cell); continue; }
    fall.broken.push({ cell, pos }); // a leaf never stops a tree: it breaks
    probe.onLeaf?.(cell, pos);
  }
  if (fall.broken.length) {
    body.cells = kept;
    if (!body.cells.length) { fall.state = 'rest'; return 'resting'; }
  }
  if (blocked) {
    fall.angle = was; // back to the last free pose: the body never overlaps the world
    if (fall.omega < SETTLE_OMEGA || fall.bounces >= MAX_BOUNCES) { fall.state = 'rest'; return 'resting'; }
    fall.bounces++;
    fall.omega = -fall.omega * RESTITUTION;
    return 'falling';
  }
  if (fall.angle >= FLAT) { fall.state = 'rest'; return 'resting'; } // lying on the ground
  return 'falling';
}
