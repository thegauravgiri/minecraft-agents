// Goal-level tactical skills built from the primitives: approach, tower_to, dig_to, deliver, collect.
const { Vec3 } = require("vec3");
const { goals, goto } = require("./move");
const { pillarUp, digDown } = require("./vertical");
const { collectDrops, scaffoldItem } = require("./blocks");
const { mine } = require("./gather");
const { sleep, throwIfAborted, waitFor, ok, fail, invCount, log } = require("../runtime/util");
const { playerEntity } = require("./follow");

// Long water between us and the target: boat if we hold/can make one, otherwise swim it.
async function crossWaterIfNeeded(ctx, p) {
  const { bot } = ctx;
  const boat = require("./boat");
  const mode = boat.shouldUseWater(bot, p);
  if (mode === "walk") return null;
  if (mode === "boat") {
    const r = await boat.boatTo(ctx, { pos: p, maxMs: 60000 });
    if (r.ok) return r;
    ctx.agent?.think(`boat failed (${r.reason}) - swimming instead`);
  }
  return boat.swimAcross(ctx, { pos: p, timeout: 60000 });
}

async function approach(ctx, { pos, name, range = 4 }) {
  const { bot } = ctx;
  const p = new Vec3(pos.x, pos.y, pos.z);
  if (bot.entity.position.distanceTo(p) > 8) {
    const w = await crossWaterIfNeeded(ctx, p);
    if (w && !w.ok && w.reason !== "stuck") return w;
  }
  const r = await goto(ctx, new goals.GoalNear(p.x, p.y, p.z, range), { timeout: range < 3 ? 40000 : 15000, towardPos: p, noProgressMs: 3000 });
  if (bot.entity.position.distanceTo(p) <= range + 4 && ctx.agent?.goal) ctx.agent.goal.progress.arrived = 1;
  // partial progress is fine: the next plan uses fresher coordinates
  if (!r.ok && r.reason === "no_path" && bot.entity.position.distanceTo(p) > 20) return fail("no_path_to_target");
  return ok({ reason: r.reason });
}

async function ensureBlocks(ctx, n = 8) {
  const { bot } = ctx;
  const have = () => bot.inventory.items().filter((i) => ["dirt", "cobblestone", "cobbled_deepslate", "netherrack", "stone", "oak_planks", "andesite", "diorite", "granite", "sand"].includes(i.name)).reduce((a, i) => a + i.count, 0);
  if (have() >= n) return ok();
  return mine(ctx, { blocks: ["dirt", "grass_block", "stone", "cobblestone"], accept: ["dirt", "cobblestone"], count: n - have() });
}

async function towerTo(ctx, { id }) {
  const { bot } = ctx;
  const e = bot.entities[id];
  if (!e) return fail("target_gone");
  const need = Math.max(2, Math.ceil(e.position.y - bot.entity.position.y) + 1);
  const b = await ensureBlocks(ctx, need + 2);
  if (!b.ok) return fail("no_blocks_for_tower:" + b.reason);
  const e2 = bot.entities[id];
  if (!e2) return fail("target_gone");
  return pillarUp(ctx, { untilY: Math.floor(e2.position.y) });
}

async function digTo(ctx, { id }) {
  const { bot } = ctx;
  const e = bot.entities[id];
  if (!e) return fail("target_gone");
  return digDown(ctx, { targetY: Math.floor(e.position.y), toward: e.position });
}

async function deliver(ctx, { player, item, count }) {
  const { bot, signal } = ctx;
  let e = playerEntity(bot, player);
  if (!e && ctx.agent?.chaseOffscreen) {                    // not in sight: find them (radar / dimension) before giving up
    const t0 = Date.now();
    while (!e && Date.now() - t0 < 25000) { throwIfAborted(signal); await ctx.agent.chaseOffscreen(ctx, player); e = playerEntity(bot, player); if (!e) await sleep(500, signal); }
  }
  if (!e) return fail("player_not_visible");
  const w = await goto(ctx, new goals.GoalNear(e.position.x, e.position.y, e.position.z, 2.3), { timeout: 20000, towardPos: e.position });
  if (!w.ok && bot.entity.position.distanceTo(e.position) > 3.5) return fail("cannot_reach_player:" + w.reason);
  const have = () => invCount(bot, item);
  const before = have();
  const n = Math.min(count, before);
  if (!n) return fail("item_missing");
  // drop at their feet from close range; confirm they actually picked it up
  let collected = 0;
  const onCollect = (collector, drop) => {
    if (collector?.username?.toLowerCase() !== player.toLowerCase()) return;
    try { const it = drop.getDroppedItem?.(); if (it?.name === item) collected += it.count; } catch { /* metadata race */ }
  };
  bot.on("playerCollect", onCollect);
  try {
    const pe = playerEntity(bot, player) || e;
    await bot.lookAt(pe.position.offset(0, 0.2, 0), true);
    const it = bot.inventory.items().find((i) => i.name === item);
    await bot.toss(it.type, null, n);
    // step back so we don't re-collect our own drop before the player can
    bot.setControlState("back", true);
    await sleep(900, signal);
    bot.setControlState("back", false);
    const got = await waitFor(() => collected >= n, { timeout: 5000, interval: 100, signal });
    const gave = before - have();
    if (got) return { ok: true, data: { gave: n }, progress: { delivered: n } };
    // dropped but not picked up (they walked away?): try to re-collect so nothing is lost
    await collectDrops(ctx, { accept: [item], radius: 8, maxMs: 4000 });
    return fail(gave > 0 ? "not_picked_up" : "toss_failed", { gave });
  } finally { bot.removeListener("playerCollect", onCollect); }
}

async function collect(ctx, { accept = null }) {
  const cr = require("./creative");
  // a full bag cannot pick anything up: in creative the least useful stack is simply binned
  if (cr.isCreative(ctx.bot)) for (let i = 0; i < 4 && cr.freeSlot(ctx.bot) < 0; i++) if ((await cr.makeRoom(ctx, {})) < 0) break;
  const n = await collectDrops(ctx, { accept, radius: 24, maxMs: 25000 });
  return { ok: true, data: { picked: n }, progress: { collectRuns: 1 } };
}

module.exports = { approach, towerTo, digTo, deliver, collect, ensureBlocks };
