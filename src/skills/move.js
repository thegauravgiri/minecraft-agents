// Navigation with real stuck handling. All skills go through goto() so there is exactly
// one place that knows how to notice "I'm not getting anywhere" and what to do about it.
const { Movements, goals } = require("mineflayer-pathfinder");
const { Vec3 } = require("vec3");
const { sleep, throwIfAborted, ok, fail, dist3, log } = require("../runtime/util");
const { PROTECTED, isProtected, digBlock, scaffoldItem, BUILT } = require("./blocks");
const { isCreative, flyTo } = require("./creative");

// Things a player built look like this: never tunnel through them (use the door instead).

const MOVE_CACHE = new WeakMap(); // building Movements walks every block name: reuse for a few seconds
function configureMovements(bot, opts = {}) {
  const key = JSON.stringify([opts.dig ?? true, opts.scaffold ?? true, opts.sprint ?? true, bot.inventory.items().map((i) => i.name).sort().join(","), opts.mem?.recall?.("house")?.origin || null]);
  const c = MOVE_CACHE.get(bot);
  if (c && c.key === key && Date.now() - c.t < 4000) return c.m;
  const m = buildMovements(bot, opts);
  MOVE_CACHE.set(bot, { key, t: Date.now(), m });
  return m;
}

function buildMovements(bot, { dig = true, scaffold = true, sprint = true, mem = null } = {}) {
  const m = new Movements(bot);
  m.canDig = dig;
  m.allowSprinting = sprint;
  m.allowParkour = true;
  m.maxDropDown = 3;
  m.digCost = 3;
  m.placeCost = 2;
  m.allow1by1towers = true;
  m.canOpenDoors = false; // doors are handled by useDoorToward()/walkThroughDoor(): the pathfinder sees open doors as solid
  // protect houses we know about (with a 1-block margin) plus anything that looks player-built
  const house = mem?.recall?.("house");
  const box = house?.origin && house?.size ? { x0: house.origin.x - 1, y0: house.origin.y - 1, z0: house.origin.z - 1, x1: house.origin.x + house.size.w + 1, y1: house.origin.y + house.size.h + 3, z1: house.origin.z + house.size.d + 1 } : null;
  m.exclusionAreasBreak.push((block) => {
    const n = block.name;
    if (box) { const p = block.position; if (p.x >= box.x0 && p.x <= box.x1 && p.y >= box.y0 && p.y <= box.y1 && p.z >= box.z0 && p.z <= box.z1) return 1000; }
    return BUILT.test(n) ? 1000 : 0;
  });
  for (const name of Object.keys(bot.registry.blocksByName)) {
    if (isProtected(name)) m.blocksCantBreak.add(bot.registry.blocksByName[name].id);
  }
  for (const n of ["lava", "fire", "soul_fire", "cactus", "sweet_berry_bush", "magma_block", "campfire", "wither_rose", "powder_snow", "cobweb"]) {
    const b = bot.registry.blocksByName[n];
    if (b) m.blocksToAvoid.add(b.id);
  }
  m.scafoldingBlocks = [];
  if (scaffold) {
    const names = new Set(bot.inventory.items().map((i) => i.name));
    for (const n of ["dirt", "cobblestone", "cobbled_deepslate", "netherrack", "stone", "andesite", "diorite", "granite", "tuff", "oak_planks", "spruce_planks", "birch_planks"]) {
      const b = bot.registry.itemsByName[n];
      if (b && names.has(n)) m.scafoldingBlocks.push(b.id);
    }
  }
  return m;
}

// ---- sprint-jumping ----------------------------------------------------------------------------------------
// A player who sprint-jumps covers ~7.1 blocks/s vs 5.6 for plain sprinting. While the pathfinder is running us in a
// steady line over flat, clear ground, hop on every landing. Backs off automatically near walls, ledges, liquids,
// farmland, low ceilings, and while digging/placing.
const NO_HOP_FLOOR = /(water|lava|magma_block|cactus|farmland|ice|soul_sand|honey_block|slime_block|powder_snow|sweet_berry_bush|cobweb|ladder|vine|scaffolding|snow)$/;
function corridorClear(bot, yaw, n = 4, groundY = null) {
  const p = bot.entity.position;
  const dx = -Math.sin(yaw), dz = -Math.cos(yaw);
  const y = groundY ?? Math.floor(p.y + 0.01);
  for (let i = 1; i <= n; i++) {
    const x = Math.floor(p.x + dx * i), z = Math.floor(p.z + dz * i);
    const floor = bot.blockAt(new Vec3(x, y - 1, z));
    if (!floor || floor.boundingBox !== "block" || NO_HOP_FLOOR.test(floor.name)) return false;
    for (const dy of [0, 1, 2, 3]) {
      const b = bot.blockAt(new Vec3(x, y + dy, z));
      if (!b || b.boundingBox === "block" || /(water|lava|fire|cactus|berry_bush|cobweb)$/.test(b.name)) return false;
    }
  }
  return true;
}

/**
 * Sprint-jump dash: for a long, clear, straight stretch the bot drives the controls itself (bunny-hopping, ~7 blocks/s)
 * instead of the pathfinder (~5.6). Returns metres gained; stops at anything unsafe so the pathfinder can take over.
 */
async function dash(ctx, tx, tz, { stopDist = 12, maxMs = 9000 } = {}) {
  const { bot, signal } = ctx;
  const start = bot.entity.position.clone();
  const t0 = Date.now();
  let last = start.clone(), lastT = t0;
  let groundY = Math.floor(start.y + 0.01);
  try {
    bot.pathfinder.stop();
    while (Date.now() - t0 < maxMs) {
      throwIfAborted(signal);
      const p = bot.entity.position;
      const dx = tx - p.x, dz = tz - p.z, d = Math.hypot(dx, dz);
      if (d <= stopDist || bot.food <= 6 || bot.entity.isInWater) { if (process.env.DASH_TRACE) log('dash', `exit: d=${d.toFixed(1)} food=${bot.food}`); break; }
      if (bot.entity.onGround) groundY = Math.floor(p.y + 0.01);      // measure from the ground we last stood on, not mid-jump height
      const yaw = Math.atan2(-dx, -dz);
      if (!corridorClear(bot, yaw, 5, groundY)) { if (process.env.DASH_TRACE) log('dash', `exit: corridor blocked at ${p.x.toFixed(1)},${p.z.toFixed(1)} after ${(Date.now() - t0)}ms`); break; }
      await bot.look(yaw, 0, true);
      bot.setControlState("forward", true); bot.setControlState("sprint", true);
      bot.setControlState("jump", bot.entity.onGround);
      await sleep(45, signal);
      if (Date.now() - lastT > 900) { if (p.distanceTo(last) < 1.2) { if (process.env.DASH_TRACE) log('dash', `exit: no progress at ${p.x.toFixed(1)},${p.z.toFixed(1)}`); break; } last = p.clone(); lastT = Date.now(); }   // not getting anywhere
    }
  } finally { for (const c of ["forward", "sprint", "jump"]) bot.setControlState(c, false); }
  return bot.entity.position.distanceTo(start);
}

const horiz = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

const isDoorBlock = (b) => b && /(_door|fence_gate)$/.test(b.name) && !b.name.includes("iron");

async function ensureOpen(ctx, door) {
  const { bot, signal } = ctx;
  for (let i = 0; i < 2; i++) {
    const cur = bot.blockAt(door.position);
    if (cur?.getProperties?.().open === true) return true;
    await bot.lookAt(door.position.offset(0.5, 0.5, 0.5), true);
    try { await bot.activateBlock(cur); } catch { /* retry */ }
    await sleep(350, signal);
  }
  return bot.blockAt(door.position)?.getProperties?.().open === true;
}

/** Walk straight through an (opened) door along `step` (unit vector pointing from the near side to the far side). */
async function walkThroughDoor(ctx, door, step) {
  const { bot, signal } = ctx;
  await ensureOpen(ctx, door);
  const axis = step.x !== 0 ? "x" : "z", dir = step.x !== 0 ? step.x : step.z;
  const doorCoord = (axis === "x" ? door.position.x : door.position.z) + 0.5;
  const dest = door.position.offset(0.5 + step.x * 2.4, 0, 0.5 + step.z * 2.4);
  const t0 = Date.now();
  bot.setControlState("forward", true);
  try {
    while (Date.now() - t0 < 3500) {
      await bot.lookAt(new Vec3(dest.x, bot.entity.position.y + 1.62, dest.z), true);
      const pos = bot.entity.position;
      if ((axis === "x" ? pos.x : pos.z) * dir > doorCoord * dir + 1.2) return true;
      // door swung shut (or never opened): open it again
      if (Date.now() - t0 > 900 && bot.blockAt(door.position)?.getProperties?.().open === false) { bot.setControlState("forward", false); await ensureOpen(ctx, door); bot.setControlState("forward", true); }
      await sleep(60, signal);
    }
    return false;
  } finally { bot.setControlState("forward", false); }
}

/**
 * The target is inside a building we can't path into: find a door near the target, stand on the outside, open it
 * and walk in. Never touches the walls. Returns true if we got through.
 */
async function useDoorToward(ctx, target) {
  const { bot } = ctx;
  const ids = Object.values(bot.registry.blocksByName).filter((b) => /(_door|fence_gate)$/.test(b.name) && !b.name.includes("iron")).map((b) => b.id);
  const doors = bot.findBlocks({ matching: ids, maxDistance: 48, count: 20 })
    .map((p) => bot.blockAt(p)).filter((b) => b && (b.getProperties?.().half !== "upper"))
    .filter((b) => Math.hypot(b.position.x - target.x, b.position.z - target.z) <= 12)
    .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position));
  for (const door of doors.slice(0, 3)) {
    const facing = door.getProperties?.().facing; // the side the door faces
    const axisX = facing === "east" || facing === "west";
    const sides = axisX ? [new Vec3(1, 0, 0), new Vec3(-1, 0, 0)] : [new Vec3(0, 0, 1), new Vec3(0, 0, -1)];
    // approach from the side nearest to us (the outside), go through toward the other side
    sides.sort((a, b) => door.position.plus(a).distanceTo(bot.entity.position) - door.position.plus(b).distanceTo(bot.entity.position));
    const near = sides[0], far = sides[1];
    const stand = door.position.plus(near.scaled(1.5));
    const g = new goals.GoalNear(stand.x + 0.5, stand.y, stand.z + 0.5, 0.8);
    bot.pathfinder.setMovements(configureMovements(bot, { dig: false, mem: ctx.mem }));
    const w = await goto(ctx, g, { timeout: 25000, dig: false, towardPos: stand, noDoor: true });
    if (!w.ok) continue;
    if (await walkThroughDoor(ctx, door, far)) { log("move", `entered through door at ${door.position}`); return true; }
  }
  return false;
}

/**
 * Try to clear whatever is in the way ahead: open a door/gate/trapdoor, otherwise dig the
 * blocking block, otherwise hop. Returns a short description of what it did.
 */
async function breakFree(ctx, toward) {
  const { bot, signal } = ctx;
  const p = bot.entity.position;
  const dx = toward ? toward.x - p.x : -Math.sin(bot.entity.yaw);
  const dz = toward ? toward.z - p.z : -Math.cos(bot.entity.yaw);
  const len = Math.hypot(dx, dz) || 1;
  const step = new Vec3(Math.round(dx / len), 0, Math.round(dz / len));
  const feet = p.floored();
  for (const dy of [0, 1]) {
    const b = bot.blockAt(feet.plus(step).offset(0, dy, 0));
    if (!b) continue;
    if (isDoorBlock(b)) { if (await walkThroughDoor(ctx, b, step)) return "through:" + b.name; }
    if (/trapdoor$/.test(b.name) && !b.name.includes("iron")) {
      try { if (b.getProperties?.().open === false) { await bot.activateBlock(b); await sleep(250, signal); } return "opened:" + b.name; } catch { /* fallthrough */ }
    }
    if (b.boundingBox === "block" && b.diggable && !isProtected(b.name) && !BUILT.test(b.name)) {
      const r = await digBlock(ctx, b);
      if (r.ok) return "dug:" + b.name;
    }
  }
  // vertical: solid above head? dig it so we can jump up
  const head = bot.blockAt(feet.offset(0, 2, 0));
  if (head && head.boundingBox === "block" && head.diggable && !isProtected(head.name) && toward && toward.y > p.y + 1) {
    const r = await digBlock(ctx, head);
    if (r.ok) return "dug_head:" + head.name;
  }
  bot.setControlState("forward", true); bot.setControlState("jump", true); bot.setControlState("sprint", true);
  await sleep(450, signal);
  bot.setControlState("forward", false); bot.setControlState("jump", false); bot.setControlState("sprint", false);
  return "hopped";
}

/**
 * Walk to a pathfinder goal. Resolves {ok} when the goal is satisfied, else {ok:false, reason}.
 * Reasons: no_path, timeout, stuck, aborted (thrown).
 */
// Roofed (indoors)? A solid, non-foliage block within 7 blocks above the point.
function isIndoors(bot, p) {
  for (let dy = 2; dy <= 7; dy++) {
    const b = bot.blockAt(new Vec3(Math.floor(p.x), Math.floor(p.y) + dy, Math.floor(p.z)));
    if (b && b.boundingBox === "block" && !/(leaves|log|wood)$/.test(b.name)) return true;
  }
  return false;
}

// Big vertical gap and the pathfinder can't help: dig a staircase up/down toward the target instead of hopping in place.
async function verticalFallback(ctx, towardPos) {
  const { bot } = ctx;
  const dy = towardPos.y - bot.entity.position.y;
  if (Math.abs(dy) < 6) return false;
  const v = require("./vertical");
  log("move", `vertical gap ${Math.round(dy)}: ${dy > 0 ? "digging stairs up" : "digging stairs down"} toward target`);
  const toward = new Vec3(towardPos.x, towardPos.y, towardPos.z);
  const r = dy > 0 ? await v.ascend(ctx, { targetY: towardPos.y - 1, toward }) : await v.digDown(ctx, { targetY: towardPos.y + 1, toward });
  log("move", `vertical fallback -> ${r.ok ? "ok" : r.reason}`);
  return r.ok || (r.data && Math.abs((r.data.y ?? bot.entity.position.y) - towardPos.y) < Math.abs(dy) - 3);
}

async function goto(ctx, goal, { timeout = 60000, dynamic = false, dig = true, noProgressMs = 2200, towardPos = null, maxStrikes = 3, noDoor = false } = {}) {
  const { bot, signal } = ctx;
  throwIfAborted(signal);
  const bad = (v) => v != null && typeof v === "number" && !Number.isFinite(v);
  if ([goal.x, goal.y, goal.z, towardPos?.x, towardPos?.y, towardPos?.z].some(bad)) return fail("invalid_target");
  let triedDoorEarly = false;
  bot.pathfinder.setMovements(configureMovements(bot, { dig, mem: ctx.mem }));
  const reached = () => {
    try { return goal.isEnd(bot.entity.position.floored()); } catch { return false; }
  };
  if (reached() && !dynamic) return ok("already");
  // target is inside a building and we are outside: use the door first, never tunnel through a wall
  if (!noDoor && towardPos && isIndoors(bot, towardPos) && !isIndoors(bot, bot.entity.position)) {
    triedDoorEarly = true;
    if (await useDoorToward(ctx, towardPos)) bot.pathfinder.setMovements(configureMovements(bot, { dig, mem: ctx.mem }));
  }

  // CREATIVE: fly the long way instead of walking/sailing; the pathfinder only handles the final approach
  const tgt0 = goal.entity ? goal.entity.position : (goal.x != null && goal.z != null ? { x: goal.x, y: goal.y, z: goal.z } : null);
  if (isCreative(bot) && tgt0 && !ctx.noFly && Math.hypot(tgt0.x - bot.entity.position.x, tgt0.z - bot.entity.position.z) > 10) {
    const me = bot.entity.position;
    const d = Math.hypot(tgt0.x - me.x, tgt0.z - me.z) || 1;
    const back = goal.entity ? 2.8 : 0;                                   // land beside a player, not inside them
    const lx = tgt0.x - ((tgt0.x - me.x) / d) * back, lz = tgt0.z - ((tgt0.z - me.z) / d) * back;
    log("move", `creative: flying to ${Math.round(lx)} ${Math.round(tgt0.y ?? me.y)} ${Math.round(lz)}`);
    await flyTo(ctx, lx, tgt0.y ?? me.y, lz);
    if (reached() && !dynamic) return ok("flew");
  }

  let noPath = false, triedDoor = noDoor || triedDoorEarly;
  const onUpdate = (r) => { if (r.status === "noPath") noPath = true; else if (r.status === "success" || r.status === "partial") noPath = false; };
  bot.on("path_update", onUpdate);
  bot.pathfinder.setGoal(goal, dynamic);

  const t0 = Date.now();
  let lastDash = 0, dashCooldown = 300;
  let anchor = bot.entity.position.clone();
  let anchorT = t0;
  let strikes = 0;
  let noPathSince = 0;
  try {
    for (;;) {
      throwIfAborted(signal);
      await sleep(60, signal);
      if (reached() && !dynamic) return ok("reached");
      if (dynamic && reached()) return ok("reached");
      const now = Date.now();
      if (now - t0 > timeout) return fail("timeout");
      // long, clear, straight stretch: sprint-jump it ourselves (faster than the pathfinder), hand back at any obstacle
      const tgt = goal.entity ? goal.entity.position : (goal.x != null && goal.z != null ? { x: goal.x, z: goal.z } : null);
      if (tgt && !ctx.noDash && now - lastDash > dashCooldown && !bot.pathfinder.isMining?.() && !bot.pathfinder.isBuilding?.() && bot.entity.onGround) {
        const far = Math.hypot(tgt.x - bot.entity.position.x, tgt.z - bot.entity.position.z);
        const aim = Math.atan2(-(tgt.x - bot.entity.position.x), -(tgt.z - bot.entity.position.z));
        if (far > (dynamic ? 16 : 22) && corridorClear(bot, aim, 5)) {
          lastDash = Date.now();
          const gained = await dash(ctx, tgt.x, tgt.z, { stopDist: dynamic ? 8 : 14 });
          bot.pathfinder.setGoal(goal, dynamic);
          dashCooldown = gained > 3 ? 300 : 3000;     // a failed dash must not keep interrupting the pathfinder
          if (gained > 3) { anchor = bot.entity.position.clone(); anchorT = Date.now(); continue; }
        }
      }
      // never path on while drowning: hand control back so the surface reflex / swim skills can act
      if (bot.oxygenLevel != null && bot.oxygenLevel <= 7 && bot.blockAt(bot.entity.position.offset(0, 1.62, 0))?.name === "water") return fail("drowning");

      if (noPath) {
        if (!noPathSince) noPathSince = now;
        if (now - noPathSince > 1200) {
          if (!triedDoor && towardPos) {
            triedDoor = true; bot.pathfinder.stop();
            if (await useDoorToward(ctx, towardPos)) { noPath = false; noPathSince = 0; bot.pathfinder.setMovements(configureMovements(bot, { dig, mem: ctx.mem })); bot.pathfinder.setGoal(goal, dynamic); continue; }
          }
          if (towardPos && !ctx.__vdone && Math.abs(towardPos.y - bot.entity.position.y) >= 6) {
            ctx.__vdone = true; bot.pathfinder.stop();
            const moved = await verticalFallback(ctx, towardPos); ctx.__vdone = false;
            if (moved) { noPath = false; noPathSince = 0; bot.pathfinder.setMovements(configureMovements(bot, { dig, mem: ctx.mem })); bot.pathfinder.setGoal(goal, dynamic); anchor = bot.entity.position.clone(); anchorT = Date.now(); continue; }
          }
          // last resort before giving up: try to carve/hop toward it once
          if (strikes < 1 && towardPos) { strikes++; await breakFree(ctx, towardPos); noPath = false; noPathSince = 0; bot.pathfinder.setGoal(goal, dynamic); continue; }
          return fail("no_path");
        }
      } else noPathSince = 0;

      // movement progress watchdog (digging/placing counts as progress)
      const busy = bot.targetDigBlock || bot.pathfinder.isMining?.() || bot.pathfinder.isBuilding?.();
      const moved = dist3(bot.entity.position, anchor);
      if (moved > 0.6 || busy) { anchor = bot.entity.position.clone(); anchorT = now; continue; }
      if (now - anchorT > noProgressMs) {
        if (!triedDoor && towardPos) {
          triedDoor = true; bot.pathfinder.stop();
          if (await useDoorToward(ctx, towardPos)) { bot.pathfinder.setMovements(configureMovements(bot, { dig, mem: ctx.mem })); bot.pathfinder.setGoal(goal, dynamic); anchor = bot.entity.position.clone(); anchorT = Date.now(); continue; }
        }
        if (towardPos && !ctx.__vdone && strikes >= 1 && Math.abs(towardPos.y - bot.entity.position.y) >= 6) {
          ctx.__vdone = true; bot.pathfinder.stop();
          const moved = await verticalFallback(ctx, towardPos); ctx.__vdone = false;
          if (moved) { bot.pathfinder.setMovements(configureMovements(bot, { dig, mem: ctx.mem })); bot.pathfinder.setGoal(goal, dynamic); anchor = bot.entity.position.clone(); anchorT = Date.now(); continue; }
        }
        strikes++;
        log("move", `stuck #${strikes} at ${bot.entity.position.floored()} -> ${towardPos || "?"}`);
        if (strikes > maxStrikes) return fail("stuck");
        bot.pathfinder.stop();
        const what = await breakFree(ctx, towardPos || goal.entity?.position || (goal.x != null ? new Vec3(goal.x, goal.y ?? bot.entity.position.y, goal.z) : null));
        log("move", "breakFree ->", what);
        bot.pathfinder.setGoal(goal, dynamic);
        anchor = bot.entity.position.clone(); anchorT = Date.now();
      }
    }
  } finally {
    bot.removeListener("path_update", onUpdate);
    if (!dynamic) { try { bot.pathfinder.stop(); } catch {} }
  }
}

const gotoPos = (ctx, p, range = 1, opts = {}) =>
  goto(ctx, range <= 0.5 ? new goals.GoalBlock(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)) : new goals.GoalNear(p.x, p.y, p.z, range), { towardPos: p, ...opts });

module.exports = { dash, corridorClear, configureMovements, goto, gotoPos, breakFree, goals };
