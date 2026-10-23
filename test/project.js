// Unit test: the project board (exclusive claims, release, janitor-safe) and the village layout.
const os = require("os"), path = require("path"), assert = require("assert");
process.env.MC_SHARED_DIR = path.join(os.tmpdir(), "mcbot-proj-test-" + Date.now());
const board = require("../src/runtime/project");
const { layoutPlots } = require("../src/core/layout");
const { audience } = require("../src/brain/team-project");
process.env.MC_AGENT_NAMES = "Vesper,Wren,Cobalt";

assert(board.create("p1", { request: "x" }), "first creator wins");
assert(!board.create("p1", { request: "x" }), "second creator loses");
board.addTasks("p1", [{ id: "a", title: "A", order: 0 }, { id: "b", title: "B", order: 1 }]);
assert(board.claim("p1", "a", "Cobalt") && !board.claim("p1", "a", "Wren"), "exactly one claim wins");
assert.strictEqual(board.tasks("p1").find((t) => t.id === "a").owner, "Cobalt");
assert(!board.release("p1", "a", "Wren"), "only the owner releases");
board.release("p1", "a", "Cobalt", { failed: true, reason: "x" });
const a = board.tasks("p1").find((t) => t.id === "a");
assert(a.state === "open" && a.owner === null && a.attempts === 1 && a.failedBy.includes("Cobalt"), "failed task is open again and remembers who failed");
assert(board.claim("p1", "a", "Wren"), "released task can be claimed again");
board.finish("p1", "a", "Wren");
assert.strictEqual(board.tasks("p1").find((t) => t.id === "a").state, "done");

const m = layoutPlots({ x: 0, z: 0 }, [{ id: "w", zone: "center", size: { w: 7, d: 7 } }, ...[1, 2, 3, 4].map((i) => ({ id: "h" + i, zone: "ring", size: { w: 11, d: 11 } })), { id: "f", zone: "outer", size: { w: 13, d: 13 } }]);
const pts = [...m.values()];
for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) assert(Math.hypot(pts[i].x - pts[j].x, pts[i].z - pts[j].z) >= 14, "plots do not overlap");

assert(audience("work together to build a village").group);
assert(audience("cobalt and wren build a wall").group);
assert(!audience("cobalt build a wall").group);
assert(!audience("wren come here").group);
const rq = require("../src/runtime/requests");
const id = rq.post({ from: "Gable", item: "oak_planks", count: 60, why: "x" });
assert(rq.open("Cobalt").some((r) => r.id === id) && !rq.open("Gable").some((r) => r.id === id), "others see my request, I do not answer myself");
assert(rq.claim(id, "Bramble") && !rq.claim(id, "Rook"), "exactly one helper takes a request");
assert(!rq.open("Cobalt").some((r) => r.id === id), "a claimed request is no longer open");
rq.release(id); assert(rq.open("Cobalt").some((r) => r.id === id), "released request is open again");
assert(rq.suppliers("oak_planks").includes("lumberjack") && rq.suppliers("iron_ingot").includes("miner") === true || rq.suppliers("iron_ingot").includes("smith"));
console.log("project board + layout + requests tests passed");
