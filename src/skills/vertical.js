// Vertical movement the pathfinder can't do reliably: tower up, stair down, climb out of holes.
// Every placement is verified; repeated failure changes tactic instead of repeating blindly.
const { Vec3 } = require("vec3");
const { goto, goals } = require("./move");
const { digBlock, scaffoldItem, solid, isProtected, isHazardousToBreak, collectDrops, GRAVITY } = require("./blocks");
const { sleep, throwIfAborted, waitFor, ok, fail, log } = require("../runtime/util");

const down = new Vec3(0, -1, 0), up = new Vec3(0, 1, 0);

async function clearOverhead(ctx, feet, n = 2) {
  for (let dy = 2; dy < 2 + n; dy++) {
    const b = ctx.bot.blockAt(feet.offset(0, dy, 0));
    if (b && b.boundingBox === "block") {
      if (isProtected(b.name) || !b.diggable) return fail("overhead_protected:" + b.name);
      const r = await digBlock(ctx, b);
      if (!r.ok) return r;
    }
  }
  return ok();
}

/** One verified pillar step. Returns ok when feet are one block higher. */
async function pillarStep(ctx, exclude = []) {
  const { bot, signal } = ctx;
  const item = scaffoldItem(bot, { exclude });
  if (!item) return fail("no_blocks");
  const feet = bot.entity.position.floored();
  const startY = bot.entity.position.y;
  const cr = await clearOverhead(ctx, feet, 2);
  if (!cr.ok) return cr;
  await bot.equip(item, "hand");
  // centre on the block so the block we place is directly beneath us
  const cx = feet.x + 0.5, cz = feet.z + 0.5;
  if (Math.hypot(bot.entity.position.x - cx, bot.entity.position.z - cz) > 0.25) {
    await goto(ctx, new goals.GoalBlock(feet.x, feet.y, feet.z), { timeout: 3000, dig: false, noProgressMs: 1500 });
  }
  await bot.look(bot.entity.yaw, -Math.PI / 2, true);
  bot.setControlState("jump", true);
  const rose = await waitFor(() => bot.entity.position.y >= feet.y + 0.85, { timeout: 700, interval: 15, signal });
  let placed = false;
  if (rose) {
    const ref = bot.blockAt(feet.offset(0, -1, 0));
    try { if (ref && ref.boundingBox === "block") { await bot.placeBlock(ref, up); placed = true; } } catch (e) { if (e.name === "AbortError") throw e; }
  }
  bot.setControlState("jump", false);
  if (!placed) return fail("place_failed");
  const ok2 = await waitFor(() => solid(bot, feet) && bot.entity.position.y >= startY + 0.9 && bot.entity.onGround, { timeout: 900, interval: 20, signal });
  return ok2 ? ok({ y: bot.entity.position.y }) : fail("no_rise");
}

/** Tower up `steps` blocks (or until feet reach untilY). */
async function pillarUp(ctx, { steps = 1, untilY = null }) {
  const { bot, signal } = ctx;
  const startY = Math.floor(bot.entity.position.y);
  const goalY = untilY != null ? untilY : startY + steps;
  let fails = 0;
  while (Math.floor(bot.entity.position.y) < goalY) {
    throwIfAborted(signal);
    ctx.beat?.();
    const r = await pillarStep(ctx);
    if (r.ok) { fails = 0; continue; }
    fails++;
    log("pillar", `step failed: ${r.reason} (#${fails})`);
    if (r.reason === "no_blocks") return r;
    if (fails === 2) {
      // reposition: step to a neighbouring column and try there
      const p = bot.entity.position.floored();
      for (const d of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const t = p.offset(d[0], 0, d[1]);
        if (solid(bot, t.offset(0, -1, 0)) && bot.blockAt(t)?.boundingBox === "empty" && bot.blockAt(t.offset(0, 1, 0))?.boundingBox === "empty") {
          await goto(ctx, new goals.GoalBlock(t.x, t.y, t.z), { timeout: 3000, dig: false, noProgressMs: 1200 }); break;
        }
      }
    }
    if (fails >= 4) return fail("pillar_stuck:" + r.reason, { y: bot.entity.position.y });
  }
  return ok({ y: bot.entity.position.y });
}

/** Dig a safe 2-high staircase downward toward targetY, heading toward (hx,hz). */
async function digDown(ctx, { targetY, toward = null }) {
  const { bot, signal } = ctx;
  let guard = 0;
  while (bot.entity.position.y > targetY + 0.5 && guard++ < 120) {
    throwIfAborted(signal);
    ctx.beat?.();
    const p = bot.entity.position.floored();
    let dir;
    if (toward) {
      const dx = toward.x - bot.entity.position.x, dz = toward.z - bot.entity.position.z;
      dir = Math.abs(dx) > Math.abs(dz) ? new Vec3(Math.sign(dx) || 1, 0, 0) : new Vec3(0, 0, Math.sign(dz) || 1);
    } else dir = new Vec3(1, 0, 0);
    // try the preferred direction, then the others
    const dirs = [dir, new Vec3(dir.z, 0, dir.x), new Vec3(-dir.z, 0, -dir.x), dir.scaled(-1)];
    let done = false;
    for (const d of dirs) {
      const head = p.plus(d).offset(0, 1, 0), mid = p.plus(d), floor = p.plus(d).offset(0, -1, 0), below = p.plus(d).offset(0, -2, 0);
      const bBelow = bot.blockAt(below), bFloor = bot.blockAt(floor), bMid = bot.blockAt(mid), bHead = bot.blockAt(head);
      if (!bBelow || !bFloor || !bMid || !bHead) continue;
      if (["lava", "water"].includes(bFloor.name) || ["lava", "water"].includes(bMid.name) || bBelow.name === "lava") continue;
      if (bBelow.boundingBox !== "block" && bBelow.name !== "water") { /* a drop > 1 below: allow only if floor is solid */ }
      for (const blk of [bHead, bMid, bFloor]) {
        if (blk.boundingBox === "block") {
          if (isProtected(blk.name) || isHazardousToBreak(bot, blk)) { done = false; break; }
          const r = await digBlock(ctx, blk);
          if (!r.ok) { done = false; break; }
        }
        done = true;
      }
      if (!done) continue;
      bot.setControlState("forward", true);
      const col = p.plus(d);
      // forward until we stand in the new column, then let gravity take us down one level
      await waitFor(() => Math.floor(bot.entity.position.x) === col.x && Math.floor(bot.entity.position.z) === col.z, { timeout: 1500, interval: 30, signal });
      bot.setControlState("forward", false);
      await waitFor(() => bot.entity.onGround && bot.entity.position.y <= p.y - 0.9, { timeout: 1500, interval: 30, signal });
      break;
    }
    if (!done) return fail("dig_down_blocked", { y: bot.entity.position.y });
  }
  return bot.entity.position.y <= targetY + 1.0 ? ok({ y: bot.entity.position.y }) : fail("dig_down_incomplete");
}

/**
 * Dig a safe staircase UP toward targetY, heading toward `toward` horizontally. Stops early on open sky/air above.
 * Each step: clear overhead + the next stair cell (2 high), never into lava/water, then hop up onto it.
 */
async function ascend(ctx, { targetY, toward = null }) {
  const { bot, signal } = ctx;
  let guard = 0, fails = 0;
  while (bot.entity.position.y < targetY - 0.5 && guard++ < 400) {
    throwIfAborted(signal);
    ctx.beat?.();
    const p = bot.entity.position.floored();
    // walkable already? let the pathfinder have a short go before digging more
    let dir;
    if (toward) {
      const dx = toward.x - bot.entity.position.x, dz = toward.z - bot.entity.position.z;
      dir = Math.abs(dx) > Math.abs(dz) ? new Vec3(Math.sign(dx) || 1, 0, 0) : new Vec3(0, 0, Math.sign(dz) || 1);
    } else dir = new Vec3(1, 0, 0);
    const dirs = [dir, new Vec3(dir.z, 0, dir.x), new Vec3(-dir.z, 0, -dir.x), dir.scaled(-1)];
    let climbed = false;
    for (const d of dirs) {
      const cells = [p.offset(0, 2, 0), p.plus(d).offset(0, 1, 0), p.plus(d).offset(0, 2, 0)];
      const blocks = cells.map((c) => bot.blockAt(c));
      if (blocks.some((b) => !b)) continue;                              // unloaded
      const above = bot.blockAt(p.plus(d).offset(0, 3, 0));
      if (blocks.some((b) => ["lava", "water"].includes(b.name)) || (above && ["lava", "water", "gravel", "sand"].includes(above.name))) continue;
      if (!solid(bot, p.plus(d))) continue;                              // the stair tread we stand on next must exist (we leave this floor block)
      let ok2 = true;
      for (const b of blocks) {
        if (b.boundingBox === "block") {
          if (isProtected(b.name) || !b.diggable || isHazardousToBreak(bot, b)) { ok2 = false; break; }
          const r = await digBlock(ctx, b);
          if (!r.ok) { ok2 = false; break; }
        }
      }
      if (!ok2) continue;
      // hop up and forward onto the new step
      await bot.lookAt(p.plus(d).offset(0.5, 1.5, 0.5), true);
      bot.setControlState("forward", true); bot.setControlState("jump", true);
      const up = await waitFor(() => bot.entity.position.y >= p.y + 0.9 && Math.floor(bot.entity.position.x) === p.x + d.x && Math.floor(bot.entity.position.z) === p.z + d.z, { timeout: 1800, interval: 40, signal });
      bot.setControlState("forward", false); bot.setControlState("jump", false);
      if (up) { climbed = true; fails = 0; break; }
    }
    if (!climbed) {
      if (++fails >= 4) return fail("ascend_blocked", { y: bot.entity.position.y });
      await sleep(200, signal);
    }
  }
  return bot.entity.position.y >= targetY - 1.5 ? ok({ y: bot.entity.position.y }) : fail("ascend_incomplete", { y: bot.entity.position.y });
}

/** How enclosed is the bot? Used to decide if "escape hole" is the right move. */
function enclosure(bot) {
  const f = bot.entity.position.floored();
  let walls = 0;
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    if (solid(bot, f.offset(dx, 0, dz)) && solid(bot, f.offset(dx, 1, dz))) walls++;
  }
  let depth = 0;
  for (let y = 1; y <= 8; y++) { const b = bot.blockAt(f.offset(0, y, 0)); if (b && b.boundingBox === "block") depth++; else if (y > 2 && depth === 0) break; }
  return { walls, ceiling: solid(bot, f.offset(0, 2, 0)) };
}

/** Climb out of a pit/hole: pillar if we have blocks, otherwise dig a staircase upward. */
async function escapeHole(ctx) {
  const { bot, signal } = ctx;
  const startY = bot.entity.position.y;
  for (let attempt = 0; attempt < 3; attempt++) {
    throwIfAborted(signal);
    // can we simply walk out?
    const w = await goto(ctx, new goals.GoalNear(bot.entity.position.x + 6, bot.entity.position.y, bot.entity.position.z, 3), { timeout: 3500, dig: false, noProgressMs: 1200 });
    if (w.ok) return ok("walked_out");
    const p = await pillarUp(ctx, { steps: 3 });
    if (p.ok) return p;
    // stair up: dig diagonal up
    for (const d of [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)]) {
      const f = bot.entity.position.floored();
      const targets = [f.plus(d).offset(0, 1, 0), f.plus(d).offset(0, 2, 0), f.offset(0, 2, 0)];
      let fine = true;
      for (const t of targets) { const b = bot.blockAt(t); if (b && b.boundingBox === "block") { const r = await digBlock(ctx, b); if (!r.ok) { fine = false; break; } } }
      if (!fine) continue;
      bot.setControlState("forward", true); bot.setControlState("jump", true);
      await sleep(700, signal);
      bot.setControlState("forward", false); bot.setControlState("jump", false);
      if (bot.entity.position.y > startY + 0.7) break;
    }
  }
  return bot.entity.position.y > startY + 0.7 ? ok("climbed") : fail("still_trapped");
}

/**
 * Burrow: the oldest survival trick. Dig a two-deep hole straight down, cap it with a block above the head, and wait for daylight
 * (or until something gets through). Used at night by anyone without a bed or a weapon, instead of dying to the first zombie.
 */
async function burrow(ctx, { maxMs = 480000 } = {}) {
  const { bot, signal } = ctx;
  const { digBlock, placeAt } = require("./blocks");
  const dayNow = () => { const t = bot.time?.clocks?.overworld?.totalTicks ?? bot.time?.time; if (t == null) return false; const d = Number(t) % 24000; return d < 12700 || d > 22800; };
  const bad = /^(water|lava|bedrock|air|cave_air|void_air|ice|sand|gravel|red_sand|chest|barrel|spawner)$/;
  const e0 = enclosure(bot);
  if (!(e0.walls >= 3 && e0.ceiling)) {
    const base = bot.entity.position.floored();
    for (let i = 0; i < 3; i++) {                                       // three cells deep: two to stand in, the top one is the cap (it needs side walls to hang on)
      throwIfAborted(signal);
      const below = bot.blockAt(bot.entity.position.offset(0, -0.6, 0));
      if (!below || below.boundingBox !== "block" || bad.test(below.name)) { if (i === 0) return fail("cannot_burrow:" + (below?.name || "nothing")); break; }
      const d = await digBlock(ctx, below); if (!d.ok) { if (i === 0) return fail("burrow_dig:" + d.reason); break; }
      await sleep(350, signal);                                        // drop into the hole
    }
    await require("./blocks").collectDrops(ctx, { radius: 3, maxMs: 1500 });
    // cap: any solid block from the bag, placed two above the feet (the cell over our head)
    const cap = bot.inventory.items().find((it) => /^(dirt|cobblestone|stone|cobbled_deepslate|netherrack|andesite|diorite|granite|tuff|oak_planks|spruce_planks|birch_planks|acacia_planks|dark_oak_planks|jungle_planks|sandstone|red_sandstone|terracotta)$/.test(it.name));
    const head = bot.entity.position.floored().offset(0, 2, 0);
    if (cap && bot.blockAt(head)?.boundingBox !== "block") await placeAt(ctx, cap, head, { tries: 3 });
  }
  ctx.agent?.think("hiding in a pit until daylight");
  const t0 = Date.now(); let lastHp = bot.health, lastDrop = 0;
  while (Date.now() - t0 < maxMs) {
    throwIfAborted(signal); ctx.beat?.();
    if (dayNow()) break;
    if (bot.health < lastHp - 0.5) lastDrop = Date.now();
    lastHp = bot.health;
    if (Date.now() - lastDrop < 3000 && bot.health < 12) return fail("attacked_in_hideout");
    await sleep(1000, signal);
  }
  const out = await escapeHole(ctx);                                    // morning: climb out
  return out.ok ? ok({ waited: Math.round((Date.now() - t0) / 1000) }) : out;
}

module.exports = { burrow, pillarUp, pillarStep, digDown, ascend, escapeHole, enclosure };
