const assert = require("assert");
const { makeRegistry } = require("../src/core/registry");
const S = require("../src/core/structure");
const reg = makeRegistry("26.1");

// two-storey 7x7 house
const house = {
  name: "two storey house", size: { w: 7, d: 7, h: 9 },
  palette: { wall: "oak_planks", floor: "spruce_planks", glass: "glass_pane", stair: "oak_stairs", door: "oak_door" },
  ops: [
    { op: "box", from: [0, 0, 0], to: [6, 0, 6], block: "floor" },
    { op: "walls", from: [0, 1, 0], to: [6, 7, 6], block: "wall" },
    { op: "box", from: [0, 4, 0], to: [6, 4, 6], block: "floor" },             // second floor slab
    { op: "clear", from: [4, 4, 4], to: [5, 4, 5] },                            // stairwell hole
    { op: "box", from: [0, 8, 0], to: [6, 8, 6], block: "wall" },               // roof
    { op: "door", at: [3, 1, 0], block: "door", facing: "north" },
    { op: "set", at: [2, 2, 0], block: "glass" },
    { op: "stairs", at: [4, 1, 5], block: "stair", facing: "east" }
  ]
};
let r = S.compileStructure(house, reg);
assert(r.ok, JSON.stringify(r.errors));
const kinds = r.cells.reduce((m, c) => ((m[c.kind] = (m[c.kind] || 0) + 1), m), {});
console.log("house cells:", r.cells.length, JSON.stringify(kinds));
assert(kinds.door === 1 && kinds.door_upper === 1 && kinds.air === 4);
assert(r.cells.some((c) => c.y === 7 && c.block === "oak_planks"), "has an upper-storey wall");
const m = S.materialsFor(r.cells, { oak_planks: 10 });
console.log("short:", JSON.stringify(m.short), "tools:", m.tools);
assert(Object.entries(m.short).some(([k, v]) => /_planks$/.test(k) && v > 100) && m.short.glass_pane === 1 && m.short.oak_door === 1);

// validation catches mistakes the AI can then repair
for (const [label, bad, expect] of [
  ["unknown block", { ...house, ops: [{ op: "box", from: [0, 0, 0], to: [1, 1, 1], block: "banana" }] }, /unknown block/],
  ["out of bounds", { ...house, ops: [{ op: "box", from: [0, 0, 0], to: [9, 1, 1], block: "wall" }] }, /outside/],
  ["bad op", { ...house, ops: [{ op: "teleport" }] }, /unknown op/],
  ["too big", { ...house, size: { w: 80, d: 9, h: 9 } }, /too large/]
]) { const x = S.compileStructure(bad, reg); assert(!x.ok && expect.test(x.errors.join()), label + " -> " + JSON.stringify(x.errors)); }

// wheat farm: tilled 9x9, water in the middle, fenced
const farm = {
  name: "wheat farm", size: { w: 9, d: 9, h: 3 }, palette: { fence: "oak_fence", gate: "oak_fence_gate" },
  ops: [
    { op: "till", from: [1, 0, 1], to: [7, 0, 7] },
    { op: "water", at: [4, 0, 4] },
    { op: "plant", from: [1, 1, 1], to: [7, 1, 7], crop: "wheat" },
    { op: "clear", from: [4, 1, 4], to: [4, 1, 4] },
    { op: "line", from: [0, 1, 0], to: [8, 1, 0], block: "fence" }, { op: "line", from: [0, 1, 8], to: [8, 1, 8], block: "fence" },
    { op: "line", from: [0, 1, 0], to: [0, 1, 8], block: "fence" }, { op: "line", from: [8, 1, 0], to: [8, 1, 8], block: "fence" },
    { op: "set", at: [4, 1, 0], block: "gate", facing: "north" }
  ]
};
r = S.compileStructure(farm, reg);
assert(r.ok, JSON.stringify(r.errors));
const fm = S.materialsFor(r.cells, {});
console.log("farm cells:", r.cells.length, "need:", JSON.stringify(fm.short), "tools:", fm.tools);
assert(fm.tools.includes("hoe") && fm.tools.includes("water_bucket") && fm.short.wheat_seeds >= 40);

// diff against a fake world
const placed = new Set(["0,0,0"]);
const world = (p) => (placed.has(`${p.x},${p.y},${p.z}`) ? "spruce_planks" : "air");
const cells = r.cells.map((c) => S.abs(c, { x: 0, y: 0, z: 0 }));
const d = S.diffStructure(S.compileStructure(house, reg).cells, world);
assert(d.missing.length > 50 && d.ratio < 0.2);
console.log("structure tests passed");

// ---- progressive building: build with what the bag covers, gather only the NEXT small batch ----
{
  const { plan } = require("../src/core/planner");
  const cabin = { name: "cabin", size: { w: 7, d: 7, h: 5 }, palette: { floor: "oak_planks", wall: "oak_planks", roof: "oak_planks" },
    ops: [{ op: "box", from: [0, 0, 0], to: [6, 0, 6], block: "floor" }, { op: "walls", from: [0, 1, 0], to: [6, 3, 6], block: "wall" }, { op: "box", from: [0, 4, 0], to: [6, 4, 6], block: "roof" }] };
  const c = S.compileStructure(cabin, reg), missing = c.cells.filter((x) => x.kind !== "air");
  const empty = S.progressivePlan(missing, {}, { batch: 40 });
  assert.strictEqual(empty.buildable, 0);
  assert.strictEqual(empty.wants.oak_planks, 40, "with an empty bag only the NEXT batch is asked for, not all " + missing.length + " blocks");
  const some = S.progressivePlan(missing, { oak_planks: 30 }, { batch: 40 });
  assert.strictEqual(some.buildable, 30);
  assert(some.wants.oak_planks === 40, "and the batch after what the bag covers");
  const g = { type: "build", spec: cabin, sid: "t1", id: 1 };
  const snap0 = { inv: {}, items: [], entities: [], players: [], pos: { x: 0, y: 64, z: 0 }, t: 0, gameMode: "survival", dimension: "overworld", health: 20, food: 20 };
  const p0 = plan(reg, g, snap0, { stations: {}, knownBlocks: new Set(["oak_log"]), avoid: new Set() });
  assert(p0.action && p0.action.skill !== "build_structure", "empty bag: gather first");
  const p1 = plan(reg, g, { ...snap0, inv: { oak_planks: 30 } }, { stations: {}, knownBlocks: new Set(), avoid: new Set() });
  assert(p1.action && p1.action.skill === "build_structure", "30 planks in the bag: start building right away");
}
console.log("progressive planning tests passed");
