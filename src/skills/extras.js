// Smaller player skills: place any block/station, emergency shelter, shield raising.
const { Vec3 } = require("vec3");
const { goto, goals } = require("./move");
const { placeAt, solid, scaffoldItem, collectDrops, isProtected } = require("./blocks");
const { findStationSpot } = require("./craft");
const { sleep, throwIfAborted, ok, fail, invCount, log } = require("../runtime/util");
const { playerEntity } = require("./follow");

/** Place `item` (chest, crafting_table, furnace, torch, bed...) on a free spot next to the bot (or the player). */
async function placeItem(ctx, { item, near = null }) {
  const { bot } = ctx;
  const it = bot.inventory.items().find((i) => i.name === item);
  if (!it) return fail("no_item:" + item);
  if (near) {
    const e = playerEntity(bot, near);
    if (e) await goto(ctx, new goals.GoalNear(e.position.x, e.position.y, e.position.z, 2.5), { timeout: 20000, towardPos: e.position });
  }
  const spot = findStationSpot(bot);
  if (!spot) return fail("no_space");
  const r = await placeAt(ctx, it, spot);
  if (!r.ok) return r;
  return { ok: true, data: { pos: spot }, progress: { placed: 1 } };
}

/** Wall ourselves in: 4 sides at feet+head height and a roof, from the scaffold blocks we carry. */
async function emergencyShelter(ctx) {
  const { bot, signal } = ctx;
  const base = bot.entity.position.floored();
  const cells = [];
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) for (const dy of [0, 1]) cells.push(base.offset(dx, dy, dz));
  // roof: the ring at head+1 first (it attaches to the wall tops), then the centre attaches to the ring
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) cells.push(base.offset(dx, 2, dz));
  cells.push(base.offset(0, 2, 0));
  let placed = 0;
  // a few sweeps: a cell that fails once (server lag, body in the way) usually works on the next pass
  for (let sweep = 0; sweep < 3; sweep++) {
    let pending = 0;
    for (const c of cells) {
      throwIfAborted(signal);
      if (solid(bot, c)) continue;
      const item = scaffoldItem(bot);
      if (!item) return placed >= 5 ? ok({ placed, partial: true }) : fail("no_blocks", { placed });
      const r = await placeAt(ctx, item, c, { tries: 2 });
      if (r.ok) placed++; else { pending++; log("shelter", `cell ${c.x - base.x},${c.y - base.y},${c.z - base.z} failed: ${r.reason}`); }
    }
    if (!pending) break;
    await sleep(150, signal);
  }
  const sealed = cells.every((c) => solid(bot, c));
  return sealed ? { ok: true, data: { placed, sealed: true }, progress: { sealed: 1 } } : fail("shelter_incomplete", { placed });
}

/** Hold a shield up for `ms` (blocks arrows/melee while closing in on ranged enemies). */
async function raiseShield(ctx, ms = 1200) {
  const { bot, signal } = ctx;
  if (bot.inventory.slots[45]?.name !== "shield") return fail("no_shield");
  bot.activateItem(true);
  try { await sleep(ms, signal); } finally { try { bot.deactivateItem(); } catch { /* ignore */ } }
  return ok();
}

/** Run away from threats (sprint-jump), used when too weak to fight and unable to wall in. */
async function flee(ctx, { from = [] }) {
  const { bot, signal } = ctx;
  const me = bot.entity.position;
  let dx = 0, dz = 0;
  for (const t of from) { dx += me.x - t.pos.x; dz += me.z - t.pos.z; }
  if (!dx && !dz) { dx = Math.random() - 0.5; dz = Math.random() - 0.5; }
  const len = Math.hypot(dx, dz) || 1;
  const target = new Vec3(me.x + (dx / len) * 20, me.y, me.z + (dz / len) * 20);
  const r = await goto(ctx, new goals.GoalNearXZ(target.x, target.z, 4), { timeout: 5000, dig: false, noProgressMs: 1500, towardPos: target });
  return r.ok ? ok() : ok({ partial: r.reason });
}

const JUNK = /^(rotten_flesh|spider_eye|poisonous_potato|flint|gravel|andesite|diorite|granite|tuff|calcite|cobbled_deepslate|deepslate|netherrack|bone|string|gunpowder|egg|feather|ink_sac|leather|kelp|seagrass|dead_bush|vine|cobweb|lily_pad|fern|short_grass|tall_grass|[a-z_]*sapling|[a-z_]*_leaves|[a-z_]*_flower|dandelion|poppy|leaf_litter|wheat_seeds|beetroot_seeds|sand|red_sand|clay_ball|snowball)$/;
const BULK = { dirt: 64, cobblestone: 128, stone: 64 };   // keep this many, toss the rest

/** Inventory almost full: toss junk (and the excess of bulk blocks) so crafting/mining never drops results on the floor. */
async function tidy(ctx) {
  const { bot, signal } = ctx;
  let tossed = 0;
  const used = () => bot.inventory.items().length;
  for (const it of [...bot.inventory.items()]) {
    if (used() <= 30) break;
    throwIfAborted(signal);
    if (JUNK.test(it.name) && !(it.name === "sand" && false)) { await bot.toss(it.type, null, it.count); tossed += it.count; await sleep(80, signal); }
  }
  for (const [name, keep] of Object.entries(BULK)) {
    if (used() <= 30) break;
    const have = bot.inventory.items().filter((i) => i.name === name).reduce((n, i) => n + i.count, 0);
    if (have > keep) { const it = bot.inventory.items().find((i) => i.name === name); await bot.toss(it.type, null, have - keep); tossed += have - keep; await sleep(80, signal); }
  }
  return ok({ tossed, slotsUsed: used() });
}

module.exports = { tidy, flee, placeItem, emergencyShelter, raiseShield };
