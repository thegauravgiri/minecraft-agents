const assert = require("assert");
const { reflex } = require("../src/core/reflex");
const mob = (name, dist, x = 0, z = 0) => ({ kind: "hostile", name, dist, pos: { x: x + dist, y: 64, z }, id: Math.floor(Math.random() * 1e6) });
const snap = (o = {}) => ({ t: 1, health: 20, food: 20, oxygen: 20, inv: {}, hostiles: [], players: [], onFire: false, inLava: false, headInWater: false, gameMode: "survival", ...o });

assert.strictEqual(reflex(snap({ hostiles: [mob("zombie", 5), mob("zombie", 6), mob("skeleton", 8)] }), { mode: "task" }).kind, "outnumbered", "3 hostiles close = outnumbered");
assert.strictEqual(reflex(snap({ hostiles: [mob("zombie", 5), mob("zombie", 20)] }), { mode: "task" }), null, "one close zombie while working is ignored (task mode engages only at 4 blocks)");
assert.strictEqual(reflex(snap({ health: 8, hostiles: [mob("zombie", 6)] }), { mode: "task" }).kind, "flee_or_block", "8 hp with a threat: get out");
const ally = { username: "Bolt", pos: { x: 12, y: 64, z: 0 } };
const r = reflex(snap({ hostiles: [mob("zombie", 12)] }), { mode: "task", allies: [ally] });
assert(r && r.kind === "defend" && r.ally === "Bolt", "a mob on a teammate is fought");
assert.strictEqual(reflex(snap({ health: 8, hostiles: [mob("zombie", 12)] }), { mode: "task", allies: [ally] }), null, "...but not when I am too hurt myself");
assert.strictEqual(reflex(snap({ gameMode: "creative", hostiles: [mob("zombie", 2), mob("zombie", 3), mob("zombie", 4)] }), {}), null, "creative: nothing to fear");
assert.strictEqual(reflex(snap({ health: 6, food: 12, inv: { rotten_flesh: 3 } }), {}).item, "rotten_flesh", "low hp, nothing else to eat: rotten flesh");
assert.strictEqual(reflex(snap({ health: 6, food: 12, inv: { rotten_flesh: 3, cooked_beef: 1 } }), {}).item, "cooked_beef", "...but real food first");
assert.strictEqual(reflex(snap({ hostiles: [mob("zombie", 8)] }), { mode: "idle", night: true }), null, "night: a zombie 8 blocks away is avoided, not hunted");
assert.strictEqual(reflex(snap({ hostiles: [mob("zombie", 2)] }), { mode: "idle", night: true }).kind, "defend", "night: something on us is fought");
assert.strictEqual(reflex(snap({ hostiles: [mob("creeper", 7)] }), { mode: "idle", night: true }).kind, "evade_creeper", "night: keep away from creepers early");
console.log("reflex tests passed");
