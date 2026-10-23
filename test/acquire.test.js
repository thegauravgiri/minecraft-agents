const assert = require("assert");
const { makeRegistry } = require("../src/core/registry");
const { planAcquire, describeStep } = require("../src/core/acquire");
const reg = makeRegistry("26.1");
const show = (label, r) => console.log(label, r.ok, "\n  " + r.steps.map(describeStep).join("\n  "));

let r = planAcquire(reg, {}, { iron_pickaxe: 1 });
show("iron_pickaxe from nothing", r);
assert(r.ok);
const ops = r.steps.map(describeStep);
assert(ops.some((s) => s.includes("smelt 3x iron_ingot")), "needs 3 ingots");
assert(ops.findIndex((s) => s.includes("wooden_pickaxe")) < ops.findIndex((s) => s.includes("iron_ore") && s.includes("mine")), "wooden pick before iron");
assert(ops.some((s) => s.includes("place furnace")) && ops.some((s) => s.includes("place crafting_table")));

r = planAcquire(reg, { oak_planks: 7, stick: 2 }, { wooden_pickaxe: 1 });
show("wooden pickaxe w/ planks", r); assert(r.ok && r.steps.length <= 3);

r = planAcquire(reg, {}, { diamond_pickaxe: 1 }); show("diamond_pickaxe", r); assert(r.ok);
r = planAcquire(reg, {}, { cooked_beef: 4 }); show("cooked_beef x4", r); assert(r.ok);
r = planAcquire(reg, {}, { white_bed: 1 }); show("white_bed", r); console.log("bed ok?", r.ok);
r = planAcquire(reg, { iron_pickaxe: 1 }, { iron_pickaxe: 1 }); assert(r.ok && r.steps.length === 0);
console.log("OK");
