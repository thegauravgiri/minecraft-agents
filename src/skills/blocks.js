// Block-level primitives: tool selection, digging, placing, picking up drops.
const { Vec3 } = require("vec3");
const { goals } = require("mineflayer-pathfinder");
const { sleep, throwIfAborted, waitFor, ok, fail, dist3, log } = require("../runtime/util");

const PROTECTED = /(^|_)(chest|barrel|furnace|smoker|crafting_table|anvil|enchanting_table|brewing_stand|bed|door|sign|lectern|bookshelf|beacon|spawner|bedrock|portal|command_block|shulker_box)$/;
const SCAFFOLD_PREF = ["dirt", "cobblestone", "cobbled_deepslate", "netherrack", "stone", "andesite", "diorite", "granite", "tuff", "sandstone", "oak_planks", "spruce_planks", "birch_planks"];
const GRAVITY = new Set(["sand", "red_sand", "gravel", "anvil"]);
const FLUID = new Set(["water", "lava", "flowing_water", "flowing_lava"]);

const isProtected = (name) => PROTECTED.test(name);
// Things a player built look like this: never tunnel through them.
const BUILT = /(planks|_bricks?$|^bricks$|_stairs$|_slab$|glass|_fence$|_wall$|concrete|terracotta|_trapdoor$|_door$|_sign$|lantern|bookshelf|_wool$|polished_|smooth_|cut_|chiseled_|_pillar$|_tiles?$)/;

// Is something solid between the bot's eyes and this block? (The server only checks distance, so without this the bot
// "x-rays" through walls and ground.) Returns the blocking block, or null if the block is in plain sight.
function blockerBetween(bot, block) {
  const eye = bot.entity.position.offset(0, 1.62, 0);
  const target = block.position.offset(0.5, 0.5, 0.5);
  const dir = target.minus(eye);
  const dist = Math.hypot(dir.x, dir.y, dir.z);
  if (dist < 0.8) return null;
  const hit = bot.world.raycast(eye, dir.scaled(1 / dist), dist + 0.7);
  if (!hit) return null;
  if (hit.position.x === block.position.x && hit.position.y === block.position.y && hit.position.z === block.position.z) return null;
  return bot.blockAt(hit.position);
}
// blocks that open a GUI / toggle when right-clicked: placing against them needs sneaking (or another support)
// "Is this somebody's building?" - never take planks/cobblestone/bricks/glass/doors... and never the logs of a frame (a tree has leaves around it).
// Villages, and the houses the team builds for itself, are not a quarry.
const NATURAL_NEVER = /^(cobblestone|mossy_cobblestone|stone_bricks|hay_block|torch|wall_torch|lantern|ladder|bookshelf|composter|bell|campfire|cauldron)$/;
const builtName = (n) => BUILT.test(n) || PROTECTED.test(n) || INTERACTIVE.test(n) || NATURAL_NEVER.test(n);
const builtCache = new Map();
function looksBuilt(bot, block) {
  const n = block.name;
  if (BUILT.test(n) || PROTECTED.test(n) || INTERACTIVE.test(n) || NATURAL_NEVER.test(n)) return true;
  if (/_(log|wood)$/.test(n) && !/^(crimson|warped)/.test(n)) {
    const key = `${block.position.x},${block.position.y},${block.position.z}`, hit = builtCache.get(key);
    if (hit && Date.now() - hit.t < 120000) return hit.v;
    let leaves = false;
    const p = block.position;
    for (let dx = -3; dx <= 3 && !leaves; dx++) for (let dz = -3; dz <= 3 && !leaves; dz++) for (let dy = 0; dy <= 7; dy++) { const b = bot.blockAt(p.offset(dx, dy, dz)); if (b && /_leaves$/.test(b.name)) { leaves = true; break; } }
    builtCache.set(key, { t: Date.now(), v: !leaves });
    if (builtCache.size > 4000) builtCache.clear();
    return !leaves;
  }
  return false;
}

const INTERACTIVE = /(crafting_table|furnace|smoker|chest|barrel|shulker_box|anvil|enchanting_table|brewing_stand|_door|trapdoor|fence_gate|_button|lever|note_block|_bed|loom|cartography_table|smithing_table|grindstone|stonecutter|lectern|beacon|hopper|dropper|dispenser|jukebox|cauldron|composter)$/;
const isInteractive = (name) => INTERACTIVE.test(name || "");

function bestToolFor(bot, block) {
  let best = null, bestT = Infinity;
  const consider = (item) => {
    const t = block.digTime(item ? item.type : null, false, false, true, item?.enchants);
    if (t < bestT - 1e-6) { bestT = t; best = item; }
  };
  consider(null);
  for (const it of bot.inventory.items()) {
    if (/(_pickaxe|_axe|_shovel|_hoe|shears|_sword)$/.test(it.name)) consider(it);
  }
  return { item: best, ticks: bestT };
}

async function equipFor(bot, block) {
  const { item } = bestToolFor(bot, block);
  try {
    if (item) { if (bot.heldItem?.type !== item.type) await bot.equip(item, "hand"); }
    else if (bot.heldItem && /(_pickaxe|_axe|_shovel|_hoe|_sword)$/.test(bot.heldItem.name)) {
      /* bare hand is fastest; keep the tool, harmless */
    }
  } catch (e) { /* ignore equip race */ }
}

// Dig a block we're already within reach of. Verifies the block actually changed.
async function digBlock(ctx, block, { force = false, depth = 0 } = {}) {
  const { bot, signal } = ctx;
  throwIfAborted(signal);
  if (!block || block.name === "air") return ok("already_air");
  if (!force && isProtected(block.name)) return fail("protected_block:" + block.name);
  if (bot.entity.position.offset(0, 1.62, 0).distanceTo(block.position.offset(0.5, 0.5, 0.5)) > 5.6) return fail("out_of_reach");
  // open the way first: dig whatever hides the target, like a player digging down through dirt to reach stone
  if (depth < 6 && bot.game?.gameMode !== "creative") {     // creative breaks are instant and need no line of sight
    for (let guard = 0; guard < 6; guard++) {
      const blocker = blockerBetween(bot, block);
      if (!blocker || blocker.boundingBox !== "block") break;
      if (isProtected(blocker.name) || BUILT.test(blocker.name) || !blocker.diggable) return fail("blocked_by:" + blocker.name);
      if (isHazardousToBreak(bot, blocker)) return fail("blocked_by_hazard:" + blocker.name);
      const r = await digBlock(ctx, blocker, { force, depth: depth + 1 });
      if (!r.ok) return r;
    }
  }
  await equipFor(bot, block);
  // long digs (obsidian ~9 s) must never look like a hang, and an interrupted dig is resumed, not abandoned
  const digStart = Date.now();
  const digBudget = Math.min(90000, (bestToolFor(bot, block).ticks || 40) * 50 * 1.6 + 6000);       // what this block can honestly take, with margin
  const beat = setInterval(() => { if (Date.now() - digStart < digBudget) ctx.beat?.(); }, 1000);     // a dig that overruns stops vouching for the agent being alive
  if (ctx.agent) ctx.agent.digging = true;
  const onAbort = () => { try { bot.stopDigging(); } catch { /* not digging */ } };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    for (let attempt = 0; attempt < 4; attempt++) {
      throwIfAborted(signal);
      const cur = bot.blockAt(block.position);
      if (!cur || cur.name !== block.name) break;           // gone (or changed): done
      try {
        await bot.lookAt(block.position.offset(0.5, 0.5, 0.5), true);
        if (bot.game?.gameMode === "creative") {                // instant in creative: a dig that has not landed in 2.5 s was lost, redo it
          let timer;
          const stuck = new Promise((_, rej) => { timer = setTimeout(() => { try { bot.stopDigging(); } catch { /* idle */ } rej(new Error("interrupted: dig timeout")); }, 2500); });
          try { await Promise.race([bot.dig(cur, true), stuck]); } finally { clearTimeout(timer); }
        } else {
          let timer;                                              // the server sometimes never answers a dig (reach/anticheat/another player broke it): never wait forever
          const stuck = new Promise((_, rej) => { timer = setTimeout(() => { try { bot.stopDigging(); } catch { /* idle */ } rej(new Error("dig_timeout")); }, digBudget); });
          try { await Promise.race([bot.dig(cur, true), stuck]); } finally { clearTimeout(timer); }
        }
        break;
      } catch (e) {
        if (signal?.aborted) { const err = new Error("aborted"); err.name = "AbortError"; throw err; }
        if (/dig_timeout/.test(e.message)) return fail("dig_timeout");
        if (!/abort|interrupt/i.test(e.message) || attempt === 3) return fail("dig_error:" + e.message);
        await sleep(150, signal);                              // someone nudged us: look again and keep digging
      }
    }
  } finally { clearInterval(beat); if (ctx.agent) ctx.agent.digging = false; signal?.removeEventListener("abort", onAbort); }
  const after = bot.blockAt(block.position);
  if (after && after.name === block.name) return fail("block_unchanged");
  return ok("dug");
}

function neighbours6(p) {
  return [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 1, 0), new Vec3(0, -1, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)].map((d) => p.plus(d));
}

// Would breaking this block release lava / water onto us or cause a sand-fall?
function isHazardousToBreak(bot, block, { allowWater = true } = {}) {
  for (const n of neighbours6(block.position)) {
    const b = bot.blockAt(n);
    if (!b) continue;
    if (b.name === "lava") return "lava_adjacent";
    if (!allowWater && b.name === "water") return "water_adjacent";
  }
  const above = bot.blockAt(block.position.offset(0, 1, 0));
  if (above && (GRAVITY.has(above.name) || above.name === "lava")) return "falling_above";
  return null;
}

function scaffoldItem(bot, { exclude = [] } = {}) {
  for (const n of SCAFFOLD_PREF) {
    if (exclude.includes(n)) continue;
    const it = bot.inventory.items().find((i) => i.name === n);
    if (it) return it;
  }
  // any plain full block
  return bot.inventory.items().find((i) => bot.registry.blocksByName[i.name]?.boundingBox === "block" && !GRAVITY.has(i.name) && !isProtected(i.name) && !exclude.includes(i.name) && i.name !== "tnt" && !/_ore$/.test(i.name));
}

function solid(bot, pos) {
  const b = bot.blockAt(pos);
  return !!b && b.boundingBox === "block";
}

// Place `item` so it lands at `target` (must currently be replaceable). Picks a supporting face.
async function placeAt(ctx, item, target, { tries = 3, yaw = null } = {}) {
  const { bot, signal } = ctx;
  throwIfAborted(signal);
  const cur = bot.blockAt(target);
  if (cur && cur.boundingBox === "block") return ok("occupied");
  const faces = [new Vec3(0, -1, 0), new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1), new Vec3(0, 1, 0)];
  for (let attempt = 0; attempt < tries; attempt++) {
    // plain supports first; interactive ones (tables, chests...) only as a last resort, while sneaking
    const ordered = [...faces].sort((a, b) => Number(isInteractive(bot.blockAt(target.minus(a))?.name)) - Number(isInteractive(bot.blockAt(target.minus(b))?.name)));
    for (const f of ordered) {
      const ref = bot.blockAt(target.minus(f));
      if (!ref || ref.boundingBox !== "block") continue;
      const sneak = isInteractive(ref.name);
      try {
        await bot.equip(item, "hand");
        const eyeDist = bot.entity.position.offset(0, 1.62, 0).distanceTo(ref.position.offset(0.5, 0.5, 0.5));
        if (eyeDist > 5) continue;
        await bot.lookAt(ref.position.offset(0.5 + f.x * 0.5, 0.5 + f.y * 0.5, 0.5 + f.z * 0.5), true);
        if (yaw != null) await bot.look(yaw, bot.entity.pitch, true);
        if (sneak) { bot.setControlState("sneak", true); await sleep(120, signal); }
        try { await bot.placeBlock(ref, f); } finally { if (sneak) bot.setControlState("sneak", false); }
        const placed = await waitFor(() => bot.blockAt(target)?.boundingBox === "block", { timeout: 700, interval: 30, signal });
        if (placed) return ok("placed");
        if (process.env.BUILD_TRACE) log("place", `${item.name}@${target} via ${ref.name}${f} no block after place; now=${bot.blockAt(target)?.name} me=${bot.entity.position} held=${bot.heldItem?.name} cnt=${bot.heldItem?.count}`);
      } catch (e) {
        if (e.name === "AbortError") throw e;
        if (process.env.BUILD_TRACE) log("place", `${item.name}@${target} via ${ref.name}${f}: ${e.message}`);
      }
    }
    if (process.env.BUILD_TRACE) log("place", `attempt ${attempt} ${item.name}@${target}: refs=${faces.map((f) => bot.blockAt(target.minus(f))?.name).join(",")} me=${bot.entity.position}`);
    await sleep(80, signal);
  }
  return fail("place_failed");
}

// Swim straight to an item entity the way a player does: sprint + look at it (the pitch steers dive/rise), jump to rise,
// sneak to sink onto it, and come up for air only when oxygen is really low.
async function swimToItem(ctx, id, { maxMs = 15000 } = {}) {
  const { bot, signal } = ctx;
  const t0 = Date.now();
  const total = () => bot.inventory.items().reduce((n, i) => n + i.count, 0);
  const before = total();
  if (ctx.agent) ctx.agent.swimming = true;          // tells the surface reflex not to drag us out mid-dive
  try {
    while (Date.now() - t0 < maxMs) {
      throwIfAborted(signal);
      ctx.beat?.();
      const e = bot.entities[id];
      if (!e || total() > before) return true;
      const p = bot.entity.position, t = e.position.offset(0, 0.1, 0);
      const dx = t.x - p.x, dz = t.z - p.z, dy = t.y - (p.y + 0.4);
      const hd = Math.hypot(dx, dz);
      const eyeWater = bot.blockAt(p.offset(0, 1.62, 0))?.name === "water";
      const lowAir = bot.oxygenLevel != null && bot.oxygenLevel <= 6 && eyeWater;
      if (lowAir) {                                   // up for air, then straight back down to the item
        await bot.look(bot.entity.yaw, -1.3, true);
        bot.setControlState("jump", true); bot.setControlState("forward", false); bot.setControlState("sneak", false);
        await sleep(80, signal);
        continue;
      }
      if (hd < 0.4 && Math.abs(dy) < 1.1) { await sleep(120, signal); continue; }       // on top of it: pickup happens on contact
      await bot.lookAt(t, true);
      bot.setControlState("forward", true);
      bot.setControlState("sprint", bot.food > 6);
      bot.setControlState("jump", dy > 0.35 || (!eyeWater && hd > 1.2 && dy > -0.3));    // rise toward a higher target / stay afloat while travelling
      bot.setControlState("sneak", dy < -0.9 && hd < 2.2);                                // sink onto an item below us
      await sleep(50, signal);
    }
    return false;
  } finally {
    for (const c of ["forward", "sprint", "jump", "sneak"]) bot.setControlState(c, false);
    if (ctx.agent) ctx.agent.swimming = false;
  }
}

// Walk to and pick up drops. `accept` null = anything. Pickup is detected from the INVENTORY (the entity list lags by seconds).
async function collectDrops(ctx, { accept = null, radius = 10, maxMs = 8000 } = {}) {
  const { bot, signal } = ctx;
  bot.pathfinder.setMovements(require("./move").configureMovements(bot, { dig: true, scaffold: true, mem: ctx.mem })); // drops in a pit we dug: dig/scaffold a way out
  const start = Date.now();
  const total = () => bot.inventory.items().reduce((n, i) => n + (!accept || accept.includes(i.name) ? i.count : 0), 0);
  const nameOf = (e) => { try { return e.getDroppedItem?.()?.name; } catch { return null; } };
  const skipped = new Set();
  let picked = 0;
  while (Date.now() - start < maxMs) {
    throwIfAborted(signal);
    const me = bot.entity.position;
    const items = Object.values(bot.entities).filter((e) => {
      if (!e.position || (e.name !== "item" && e.name !== "item_stack") || skipped.has(e.id)) return false;
      if (e.position.distanceTo(me) > radius) return false;
      const n = nameOf(e);
      return !accept || !n || accept.includes(n);
    }).sort((a, b) => a.position.distanceTo(me) - b.position.distanceTo(me));
    const it = items[0];
    if (!it) break;
    const before = total();
    const t0 = Date.now();
    const inWater = bot.blockAt(it.position)?.name === "water" || bot.blockAt(it.position.offset(0, 0.5, 0))?.name === "water";
    if (inWater) {
      // get close over land/shallows with the pathfinder, then swim the last stretch ourselves
      if (it.position.distanceTo(me) > 7) {
        bot.pathfinder.setGoal(new goals.GoalNear(it.position.x, it.position.y, it.position.z, 5));
        const t1 = Date.now();
        while (Date.now() - t1 < 6000 && bot.entity.position.distanceTo(it.position) > 7 && !bot.entity.isInWater) { throwIfAborted(signal); await sleep(100, signal); }
        bot.pathfinder.stop();
      }
      const got = await swimToItem(ctx, it.id);
      if (got) picked++; else skipped.add(it.id);
      continue;
    }
    if (it.position.distanceTo(me) > 0.9) bot.pathfinder.setGoal(new goals.GoalNear(it.position.x, it.position.y, it.position.z, 0.5));
    // done when the bag grew, the entity vanished, or we are standing on it for a moment; give up on this one after 2.5 s
    let onIt = 0;
    for (;;) {
      throwIfAborted(signal);
      if (total() > before || !bot.entities[it.id]) { picked++; break; }
      onIt = bot.entity.position.distanceTo(it.position) < 0.9 ? onIt + 1 : 0;
      if (onIt > 5 || Date.now() - t0 > (it.position.distanceTo(bot.entity.position) < 1.6 ? 900 : 2200)) { skipped.add(it.id); break; }
      await sleep(40, signal);
    }
    bot.pathfinder.stop();
  }
  return picked;
}

module.exports = { builtName, looksBuilt, swimToItem, BUILT, blockerBetween, PROTECTED, isProtected, isInteractive, bestToolFor, equipFor, digBlock, isHazardousToBreak, scaffoldItem, solid, placeAt, collectDrops, neighbours6, GRAVITY, FLUID };
