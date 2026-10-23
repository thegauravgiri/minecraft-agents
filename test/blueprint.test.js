const assert = require("assert");
const B = require("../src/core/blueprint");

const origin = { x: 10, y: 63, z: -5 };
const bp = B.houseBlueprint({ origin, size: { w: 5, d: 5, h: 3 }, material: "oak_planks", door: "south" });
const count = (role) => bp.cells.filter((c) => c.role === role).length;

assert.strictEqual(count("floor"), 25);
assert.strictEqual(count("roof"), 25);
assert.strictEqual(count("door_lower"), 1);
assert.strictEqual(count("door_upper"), 1);
assert.strictEqual(count("window"), 2);
assert.strictEqual(count("wall"), 16 * 3 - 2 - 2);
assert.strictEqual(bp.interior.length, 3 * 3 * 3);
assert.deepStrictEqual(bp.doorCell, { x: 12, y: 64, z: -1 });
assert.deepStrictEqual(bp.front, { x: 12, y: 64, z: 0 });
assert.deepStrictEqual(bp.behind, { x: 12, y: 64, z: -2 });

// simulated world: grass ground up to y=63, optionally built from the blueprint
function world(cellsToBuild = [], extra = {}) {
  const m = new Map();
  for (const c of cellsToBuild) m.set(`${c.x},${c.y},${c.z}`, c.role === "window" ? "glass" : c.role.startsWith("door") ? "oak_door" : c.role === "torch" ? "torch" : "oak_planks");
  for (const [k, v] of Object.entries(extra)) m.set(k, v);
  return (p) => {
    const k = `${p.x},${p.y},${p.z}`;
    if (m.has(k)) return m.get(k);
    if (p.y <= 63) return "grass_block";
    return "air";
  };
}
const built = world(bp.cells);

let d = B.diffBlueprint(bp, built);
assert.strictEqual(d.missing.length, 0);
assert.strictEqual(d.wrong.length, 0);
assert.strictEqual(d.doneRatio, 1);
let v = B.verifyHouse(bp, built);
assert.deepStrictEqual(v.problems, []);
assert(v.ok);

// empty site: floor is natural, everything above missing, ratio < 1
const empty = world([]);
d = B.diffBlueprint(bp, empty);
assert.strictEqual(d.missing.length, count("wall") + count("window") + count("roof") + 2);
assert(d.doneRatio > 0 && d.doneRatio < 0.5);
assert(!B.verifyHouse(bp, empty).ok);

// a single hole in the wall is detected, in the roof too, door missing too
const noWall = bp.cells.filter((c) => !(c.role === "wall" && c.x === 10 && c.y === 66 && c.z === -3));
v = B.verifyHouse(bp, world(noWall));
assert(!v.ok && v.problems.some((p) => p.startsWith("wall_gap")), v.problems.join());
assert(v.problems.some((p) => p.startsWith("leak")), "leak must be reported: " + v.problems.join());
const noRoof = bp.cells.filter((c) => !(c.role === "roof" && c.x === 12 && c.z === -3));
v = B.verifyHouse(bp, world(noRoof));
assert(!v.ok && v.problems.some((p) => p.startsWith("roof_gap")));
const noDoor = bp.cells.filter((c) => !c.role.startsWith("door"));
v = B.verifyHouse(bp, world(noDoor));
assert(!v.ok && v.problems.some((p) => p.startsWith("door_missing")));
d = B.diffBlueprint(bp, world(noDoor));
assert.deepStrictEqual(d.missing.map((c) => c.role).sort(), ["door_lower", "door_upper"]);

// blocked doorway and blocked interior
v = B.verifyHouse(bp, world(bp.cells, { "12,64,0": "stone" }));
assert(v.problems.some((p) => p.startsWith("front_blocked")));
v = B.verifyHouse(bp, world(bp.cells, { "11,64,-3": "dirt" }));
assert(v.problems.some((p) => p.startsWith("interior_blocked")));
d = B.diffBlueprint(bp, world(bp.cells, { "11,64,-3": "dirt" }));
assert.strictEqual(d.wrong.length, 1);
v = B.verifyHouse(bp, world(bp.cells, { "12,64,-1": "iron_door", "12,65,-1": "iron_door" }));
assert(v.problems.some((p) => p.startsWith("door_not_openable")));

// bad wall material (leaves) counts as wrong, plants as missing
const leafy = world(bp.cells, { "10,64,-3": "oak_leaves", "11,64,-5": "short_grass" });
d = B.diffBlueprint(bp, leafy);
assert.strictEqual(d.wrong.length, 1);
assert.strictEqual(d.missing.length, 1);
let obs = B.obstructions(bp, leafy);
assert.deepStrictEqual(obs.map((o) => o.name).sort(), ["oak_leaves", "short_grass"]);

// open windows must not make the verifier fail, glass must
const open = B.houseBlueprint({ origin, windows: "open" });
assert.strictEqual(open.cells.filter((c) => c.role === "window").length, 2);
v = B.verifyHouse(open, world(open.cells.filter((c) => c.role !== "window")));
assert.deepStrictEqual(v.problems, []);

// other door directions are consistent
for (const dir of ["north", "east", "west", "south"]) {
  const b = B.houseBlueprint({ origin, size: { w: 7, d: 6, h: 3 }, door: dir });
  assert(B.verifyHouse(b, world(b.cells)).ok, dir);
  const noD = world(b.cells.filter((c) => c.role !== "door_upper"));
  assert(!B.verifyHouse(b, noD).ok, dir);
}

// materials
let need = B.materialsNeeded(bp, {});
assert.strictEqual(need.oak_planks, count("floor") + count("wall") + count("roof"));
assert.strictEqual(need.glass, 2);
assert.strictEqual(need.oak_door, 1);
need = B.materialsNeeded(bp, { oak_planks: 20, birch_planks: 100, glass: 2, spruce_door: 1 }, empty, { ignoreFloor: true });
assert.deepStrictEqual(need, {});
need = B.materialsNeeded(bp, { oak_planks: 30, glass: 2 }, empty, { ignoreFloor: true });
assert.strictEqual(need.oak_planks, count("wall") + count("roof") - 30);
assert.strictEqual(need.oak_door, 1);
assert.deepStrictEqual(B.materialsNeeded(bp, { oak_planks: 5 }, built), {});

// ordering: bottom-up, every cell supported, every cell reachable from its stand
const todo = bp.cells.filter((c) => !["floor"].includes(c.role));
const ground = (p) => p.y <= 63;
const { order, stuck } = B.orderCells(todo, bp.stand, { solid: ground });
assert.strictEqual(stuck.length, 0, JSON.stringify(stuck));
assert.strictEqual(order.length, todo.filter((c) => !c.role.startsWith("door") && c.role !== "torch").length);
const placed = new Set();
let lastY = -1;
const N6 = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
for (const { cell, stand } of order) {
  assert(cell.y >= lastY, "bottom-up"); lastY = cell.y;
  assert(N6.some(([a, b, c]) => placed.has(`${cell.x + a},${cell.y + b},${cell.z + c}`) || ground({ x: cell.x + a, y: cell.y + b, z: cell.z + c })), "supported");
  assert(B.standsFor(cell, bp.stand).some((s) => s.x === stand.x && s.z === stand.z), "reachable");
  placed.add(`${cell.x},${cell.y},${cell.z}`);
}
// roof cells without any wall below and no neighbours are unplaceable
const lonely = B.orderCells([{ x: 0, y: 90, z: 0, role: "roof" }], bp.stand, { solid: ground });
assert.strictEqual(lonely.stuck.length, 1);

// fill plan: hole under the floor
const holey = world([], { "11,63,-4": "air", "11,62,-4": "air", "13,63,-3": "air" });
const fp = B.fillPlan(bp, holey);
assert.deepStrictEqual(fp.fills.map((f) => `${f.x},${f.y},${f.z}`).sort(), ["11,62,-4", "11,63,-4", "13,63,-3"]);
assert.strictEqual(fp.unsupported.length, 0);
assert.strictEqual(B.fillPlan(bp, () => "air").unsupported.length > 0, true);

// planner handler
const inv = { oak_planks: 200, oak_door: 1, glass: 4 };
assert.deepStrictEqual(B.planBuildHouse({}, { inv }, { houseVerified: true }), { done: true, remaining: 0 });
let r = B.planBuildHouse({ type: "build", what: "house" }, { inv: {} }, {});
assert(r.needs && r.needs.oak_planks > 0 && r.needs.oak_door === 1 && r.action === null);
r = B.planBuildHouse({ type: "build", what: "house" }, { inv }, {});
assert.strictEqual(r.action.skill, "build_house");
assert(r.remaining > 0);
const rec = { origin, size: bp.size, material: "oak_planks", door: "south", windows: "glass" };
const r1 = B.planBuildHouse({}, { inv }, { house: rec, houseBlockAt: empty });
const r2 = B.planBuildHouse({}, { inv }, { house: rec, houseBlockAt: world(bp.cells.filter((c, i) => i % 2 === 0)) });
assert(r2.remaining < r1.remaining, "remaining must fall as blocks appear");
assert.deepStrictEqual(r1.action.args.origin, origin);
assert(B.planBuildHouse({}, { inv }, { houseBlocked: "x" }).blocked);

console.log("blueprint tests passed");
