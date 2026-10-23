// The shared skill library: save, track record, repair-and-improve by another agent, hide broken ones, offer only relevant ones.
const os = require("os"), path = require("path"), assert = require("assert");
process.env.MC_SKILLS_DIR = path.join(os.tmpdir(), "mcbot-skills-" + Date.now());
const L = require("../src/brain/learned");

L.save({ name: "Collect Item Stack", description: "mine N blocks of a type and pick them up", params: [{ name: "block", desc: "block id" }, { name: "count", desc: "how many" }], code: "await api.mine([api.args.block], api.args.count);", by: "Cobalt" });
let s = L.find("collect_item_stack");
assert(s && s.version === 1 && s.params.length === 2 && s.authors[0] === "Cobalt");
L.record("collect_item_stack", { ok: true }); L.record("collect_item_stack", { ok: true });
assert.strictEqual(L.find("collect_item_stack").successes, 2);

// another agent repairs it: version bump, old code kept, both authors credited
L.save({ name: "collect_item_stack", code: "await api.mine([api.args.block], api.args.count);\nawait api.collect();", by: "Gable" });
s = L.find("collect_item_stack");
assert(s.version === 2 && s.history.length === 1 && s.history[0].code.includes("mine") && s.authors.join() === "Cobalt,Gable" && s.params.length === 2, "improved version, history kept, params kept");
L.save({ name: "collect_item_stack", code: s.code, by: "Bramble" });
assert.strictEqual(L.find("collect_item_stack").version, 2, "identical code is not a new version");

// retrieval: only relevant skills, best first; a broken skill is hidden
L.save({ name: "build_fence", description: "put a fence around a rectangle", params: [], code: "return 1;", by: "Gable" });
const hits = L.relevant("please mine 20 cobblestone blocks", 3);
assert.strictEqual(hits[0].name, "collect_item_stack");
for (let i = 0; i < 5; i++) L.record("build_fence", { ok: false, error: "boom" });
assert(!L.relevant("fence around the farm", 5).some((x) => x.name === "build_fence"), "a skill that keeps failing is not offered");
L.save({ name: "build_fence", code: "return 2;", by: "Rook" });
L.record("build_fence", { ok: true });
assert(L.relevant("fence around the farm", 5).some((x) => x.name === "build_fence"), "a repaired skill is offered again");
console.log(L.catalog("mine cobblestone").split("\n")[0]);
console.log("learned library tests passed");
