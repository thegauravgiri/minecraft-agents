// Crafting, station placement and smelting.
const { Vec3 } = require("vec3");
const { goals, goto } = require("./move");
const { digBlock, placeAt, solid, collectDrops, neighbours6, isInteractive } = require("./blocks");
const { sleep, throwIfAborted, waitFor, ok, fail, invCount, log } = require("../runtime/util");

function nearestBlock(bot, name, maxDistance = 40) {
  const id = bot.registry.blocksByName[name]?.id;
  if (id == null) return null;
  const b = bot.findBlock({ matching: id, maxDistance });
  return b ? b.position : null;
}

// Find an air cell next to solid ground within reach of the bot for placing a station.
function findStationSpot(bot) {
  const base = bot.entity.position.floored();
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1], [2, 0], [-2, 0], [0, 2], [0, -2]];
  for (const [dx, dz] of dirs) {
    for (const dy of [0, 1, -1]) {
      const p = base.offset(dx, dy, dz);
      const here = bot.blockAt(p), above = bot.blockAt(p.offset(0, 1, 0)), below = bot.blockAt(p.offset(0, -1, 0));
      if (here && here.boundingBox === "empty" && here.name !== "water" && above && above.boundingBox === "empty" && below && below.boundingBox === "block" && !isInteractive(below.name)) return p;
    }
  }
  return null;
}

async function placeStation(ctx, station) {
  const { bot, signal } = ctx;
  const existing = nearestBlock(bot, station, 6);
  if (existing) return ok({ pos: existing, reused: true });
  const item = bot.inventory.items().find((i) => i.name === station);
  if (!item) return fail("no_item:" + station);
  const spot = findStationSpot(bot);
  if (!spot) return fail("no_space");
  const r = await placeAt(ctx, item, spot);
  if (!r.ok) return r;
  return ok({ pos: spot });
}

async function ensureStationNearby(ctx, station) {
  const { bot } = ctx;
  let p = nearestBlock(bot, station, 5);
  if (p) return ok({ pos: p });
  p = nearestBlock(bot, station, 48);
  if (p) {
    const g = new goals.GoalNear(p.x, p.y, p.z, 2.5);
    const w = await goto(ctx, g, { timeout: 30000, towardPos: p });
    if (w.ok) return ok({ pos: p });
  }
  const r = await placeStation(ctx, station);
  return r;
}

// Craft `step.count` of `step.item` (rounded up to whole recipes).
async function craft(ctx, step) {
  const { bot, signal } = ctx;
  const item = bot.registry.itemsByName[step.item];
  if (!item) return fail("unknown_item:" + step.item);
  let tableBlock = null;
  if (step.table) {
    const st = await ensureStationNearby(ctx, "crafting_table");
    if (!st.ok) return fail("no_crafting_table:" + st.reason);
    tableBlock = bot.blockAt(st.data.pos);
  }
  const have0 = invCount(bot, step.item);
  const recipes = bot.recipesFor(item.id, null, 1, tableBlock);
  if (!recipes.length) return fail("no_recipe_or_missing_ingredients:" + step.item);
  // stand within reach of the table, then craft with a deadline: a table that never opens (too far, blocked, busy) must not hang for 20 s
  const near = () => !tableBlock || bot.entity.position.offset(0, 1.62, 0).distanceTo(tableBlock.position.offset(0.5, 0.5, 0.5)) <= 4.2;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (!near()) await goto(ctx, new goals.GoalNear(tableBlock.position.x, tableBlock.position.y, tableBlock.position.z, 2), { timeout: 12000, towardPos: tableBlock.position });
    let timer;
    try {
      await Promise.race([bot.craft(recipes[0], step.times, tableBlock || undefined), new Promise((_, rej) => { timer = setTimeout(() => rej(new Error("craft_timeout")), 9000); })]);
      break;
    } catch (e) {
      if (e.name === "AbortError" || signal?.aborted) throw e;
      try { if (bot.currentWindow) bot.closeWindow(bot.currentWindow); } catch { /* already closed */ }
      const msg = String(e.message || e);
      if (/missing ingredient/i.test(msg)) return fail("missing_ingredient:" + step.item);        // somebody else took them / bad count: let the planner recount
      if (attempt === 2) return fail(/timeout|windowOpen/i.test(msg) ? "table_unreachable" : "craft_error:" + msg.slice(0, 60));
      await sleep(400, signal);
    } finally { clearTimeout(timer); }
  }
  await sleep(150, signal);
  const gained = invCount(bot, step.item) - have0;
  if (gained > 0) return ok({ gained });
  log("craft", `no result for ${step.item}; inv=${bot.inventory.items().map((i) => i.name + "x" + i.count).join(",")}`);
  return fail("craft_no_result");
}

async function smelt(ctx, step) {
  const { bot, signal } = ctx;
  const st = await ensureStationNearby(ctx, "furnace");
  if (!st.ok) return fail("no_furnace:" + st.reason);
  const furnaceBlock = bot.blockAt(st.data.pos);
  const furnace = await bot.openFurnace(furnaceBlock);
  try {
    const inp = bot.inventory.items().find((i) => i.name === step.input);
    if (!inp) return fail("missing_input:" + step.input);
    const fuelItem = bot.inventory.items().find((i) => i.name === step.fuel) || bot.inventory.items().find((i) => ["coal", "charcoal"].includes(i.name)) || bot.inventory.items().find((i) => /_planks$|_log$/.test(i.name));
    if (!fuelItem) return fail("missing_fuel");
    const n = Math.min(step.count, inp.count);
    await furnace.putFuel(fuelItem.type, null, Math.min(fuelItem.count, Math.max(1, Math.ceil(n / (/coal|charcoal/.test(fuelItem.name) ? 8 : 1.5)))));
    await furnace.putInput(inp.type, null, n);
    const outName = step.item;
    const done = await waitFor(() => {
      const o = furnace.outputItem();
      return o && o.count >= n ? o : null;
    }, { timeout: 11000 * n + 4000, interval: 300, signal });
    if (!done) {
      const partial = furnace.outputItem();
      if (partial) await furnace.takeOutput();
      return partial ? ok({ partial: partial.count }) : fail("smelt_timeout");
    }
    await furnace.takeOutput();
    return ok({ smelted: n });
  } finally {
    try { furnace.close(); } catch { /* already closed */ }
  }
}

module.exports = { craft, smelt, placeStation, ensureStationNearby, nearestBlock, findStationSpot };
