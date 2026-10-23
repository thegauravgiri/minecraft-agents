// Short, self-contained survival reflexes: eat, surface, leave lava, put out fire.
const { Vec3 } = require("vec3");
const { goals, goto } = require("./move");
const { sleep, throwIfAborted, waitFor, ok, fail, log } = require("../runtime/util");
const { fight } = require("./combat");

async function eat(ctx, { item } = {}) {
  const { bot, signal } = ctx;
  const food = bot.inventory.items().find((i) => i.name === item) || bot.inventory.items().find((i) => bot.registry.foodsByName[i.name] && !["rotten_flesh", "spider_eye", "poisonous_potato", "pufferfish"].includes(i.name));
  if (!food) return fail("no_food");
  const f0 = bot.food, c0 = food.count;
  try {
    await bot.equip(food, "hand");
    const eating = bot.consume();
    const abort = new Promise((_, rej) => signal?.addEventListener("abort", () => { try { bot.deactivateItem(); } catch {} rej(Object.assign(new Error("aborted"), { name: "AbortError" })); }, { once: true }));
    await Promise.race([eating, abort]);
  } catch (e) {
    if (e.name === "AbortError") throw e;
    return fail("eat_error:" + e.message);
  }
  return bot.food > f0 || (bot.inventory.items().find((i) => i.name === food.name)?.count ?? 0) < c0 ? ok({ ate: food.name }) : fail("not_eaten");
}

const isLiquid = (b) => b && (b.name === "water" || b.name === "lava");

function standable(bot, p) {
  const feet = bot.blockAt(p), head = bot.blockAt(p.offset(0, 1, 0)), floor = bot.blockAt(p.offset(0, -1, 0));
  return feet && head && floor && feet.boundingBox === "empty" && !isLiquid(feet) && head.boundingBox === "empty" && !isLiquid(head) && floor.boundingBox === "block" && !["magma_block", "cactus", "fire", "campfire"].includes(floor.name);
}

function nearestStandable(bot, maxR = 8) {
  const base = bot.entity.position.floored();
  let best = null, bd = Infinity;
  for (let dx = -maxR; dx <= maxR; dx++) for (let dz = -maxR; dz <= maxR; dz++) for (let dy = -3; dy <= 3; dy++) {
    const p = base.offset(dx, dy, dz);
    const d = Math.hypot(dx, dz) + Math.abs(dy) * 1.3;
    if (d < bd && standable(bot, p)) { best = p; bd = d; }
  }
  return best;
}

async function swimTo(ctx, target, ms = 9000) {
  const { bot, signal } = ctx;
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    throwIfAborted(signal);
    const me = bot.entity.position;
    await bot.lookAt(new Vec3(target.x + 0.5, me.y + 1.2, target.z + 0.5), true);
    bot.setControlState("forward", true); bot.setControlState("jump", true); bot.setControlState("sprint", true);
    await sleep(60, signal);
    if (me.distanceTo(target) < 1.2 && bot.entity.onGround) break;
    const feet = bot.blockAt(me), eye = bot.blockAt(me.offset(0, 1.62, 0));
    if (!isLiquid(feet) && !isLiquid(eye) && bot.entity.onGround) break;
  }
  for (const c of ["forward", "jump", "sprint"]) bot.setControlState(c, false);
}

async function surface(ctx) {
  const { bot } = ctx;
  const land = nearestStandable(bot, 10);
  if (!land) {
    bot.setControlState("jump", true);
    await sleep(1500, ctx.signal);
    bot.setControlState("jump", false);
    return fail("no_land");
  }
  await swimTo(ctx, land);
  return ok();
}

async function escapeLava(ctx) {
  const { bot } = ctx;
  const bucket = bot.inventory.items().find((i) => i.name === "water_bucket");
  if (bucket) {
    try {
      await bot.equip(bucket, "hand");
      await bot.lookAt(bot.entity.position.offset(0, -1, 0), true);
      bot.activateItem();
      await sleep(250, ctx.signal);
    } catch { /* fall through to running */ }
  }
  const land = nearestStandable(bot, 8);
  if (land) await swimTo(ctx, land, 6000);
  return land ? ok() : fail("no_safe_ground");
}

async function extinguish(ctx) {
  const { bot } = ctx;
  const water = bot.findBlock({ matching: bot.registry.blocksByName.water.id, maxDistance: 12 });
  if (water) {
    const w = await goto(ctx, new goals.GoalNear(water.position.x, water.position.y, water.position.z, 0.8), { timeout: 6000, dig: false });
    if (w.ok) return ok();
  }
  const bucket = bot.inventory.items().find((i) => i.name === "water_bucket");
  if (bucket) {
    await bot.equip(bucket, "hand"); await bot.lookAt(bot.entity.position.offset(0, -1, 0), true); bot.activateItem(); await sleep(400, ctx.signal);
    return ok();
  }
  bot.setControlState("forward", true); bot.setControlState("sprint", true);
  await sleep(700, ctx.signal);
  bot.setControlState("forward", false); bot.setControlState("sprint", false);
  return ok();
}

async function evadeCreeper(ctx, target) {
  return fight(ctx, { id: target.id }, { hitAndRun: true, timeoutMs: 15000 });
}

module.exports = { eat, surface, escapeLava, extinguish, evadeCreeper, nearestStandable, standable, swimTo };
