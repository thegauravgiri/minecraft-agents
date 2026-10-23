// Resource gathering: find the best reachable block, walk, dig with the right tool, pick up drops.
const { Vec3 } = require("vec3");
const { goals, goto } = require("./move");
const { digBlock, isHazardousToBreak, collectDrops, isProtected, neighbours6, looksBuilt } = require("./blocks");
const { sleep, throwIfAborted, ok, fail, dist3, log, timed } = require("../runtime/util");

const sumInv = (bot, names) => bot.inventory.items().reduce((n, i) => (names.includes(i.name) ? n + i.count : n), 0);

// Exposed to air (or visible) => cheap to reach; buried => needs tunnelling.
function exposure(bot, pos) {
  let open = 0;
  for (const n of neighbours6(pos)) {
    const b = bot.blockAt(n);
    if (b && (b.boundingBox === "empty")) open++;
  }
  return open;
}

function findCandidates(ctx, names, { maxDistance = 64, count = 48 } = {}) {
  const { bot, mem } = ctx;
  const ids = names.map((n) => bot.registry.blocksByName[n]?.id).filter((x) => x != null);
  if (!ids.length) return [];
  const me = bot.entity.position;
  const found = bot.findBlocks({ matching: ids, maxDistance, count });
  const scored = [];
  for (const p of found) {
    if (mem.isBanned(p)) continue;
    const b = bot.blockAt(p);
    if (!b) continue;
    if (isHazardousToBreak(bot, b)) continue;
    if (looksBuilt(bot, b)) continue;                                 // somebody's house / a village: not a quarry
    const dy = p.y - me.y;
    const horiz = Math.hypot(p.x - me.x, p.z - me.z);
    // digging down/up through rock is slow; surface-exposed blocks win ties
    const score = horiz + Math.abs(dy) * 2 + (dy > 3 ? 4 : 0) - exposure(bot, p) * 1.5;
    scored.push({ pos: p, block: b, score });
  }
  scored.sort((a, b) => a.score - b.score);
  return scored;
}

// Any tree will do: a plan that says "oak_log" must not stand in a badlands next to acacia trees for ten minutes
const LOGS = ["oak_log", "spruce_log", "birch_log", "jungle_log", "acacia_log", "dark_oak_log", "mangrove_log", "cherry_log", "pale_oak_log"];
const isLogStep = (step) => (step.blocks || []).some((n) => /^(oak|spruce|birch|jungle|acacia|dark_oak|mangrove|cherry|pale_oak)_log$/.test(n));

// Where did the team find this resource? Remembered (and shared through the knowledge file) so nobody searches blindly twice.
const resKey = (names) => (names.some((n) => /_log$/.test(n)) ? "tree" : String(names[0]).replace(/^deepslate_/, "").replace(/_ore$/, " ore"));
function noteResource(ctx, names, pos, labelOverride = null, radius = 30) {
  try {
    const k = ctx.agent?.know; if (!k) return;
    const label = labelOverride || resKey(names);
    if (k.items.some((e) => e.kind === "resource" && e.label === label && Math.hypot(e.pos.x - pos.x, e.pos.z - pos.z) < radius)) return;
    k.add({ kind: "resource", label, pos });
    const mine = k.items.filter((e) => e.kind === "resource" && e.label === label);
    if (mine.length > 8) k.items.splice(k.items.indexOf(mine[0]), 1);                // keep the newest few per kind
  } catch { /* knowledge is best effort */ }
}
function knownSites(ctx, names, labelOverride = null) {
  try {
    const me = ctx.bot.entity.position, label = labelOverride || resKey(names);
    return ctx.agent.know.all().filter((e) => e.kind === "resource" && e.label === label && !ctx.mem.isBanned(new Vec3(e.pos.x, e.pos.y ?? me.y, e.pos.z)) && Math.hypot(e.pos.x - me.x, e.pos.z - me.z) > 24).sort((a, b) => Math.hypot(a.pos.x - me.x, a.pos.z - me.z) - Math.hypot(b.pos.x - me.x, b.pos.z - me.z));
  } catch { return []; }
}

const BEARINGS = Array.from({ length: 12 }, (_, i) => (i / 12) * Math.PI * 2);

// Walk somewhere new so more chunks load / new blocks come into range.
async function explore(ctx, { distance = 48, why = "" } = {}) {
  const { bot, mem, signal } = ctx;
  const me = bot.entity.position;
  mem.noteVisit(me);
  let best = null;
  for (const a of BEARINGS) {
    const x = me.x + Math.cos(a) * distance, z = me.z + Math.sin(a) * distance;
    const v = mem.visits({ x, z }) * 10 + Math.random();
    if (!best || v < best.v) best = { x, z, v };
  }
  log("explore", `${why} -> (${Math.round(best.x)}, ${Math.round(best.z)})`);
  const r = await goto(ctx, new goals.GoalNearXZ(best.x, best.z, 6), { timeout: 30000, dig: false, towardPos: new Vec3(best.x, me.y, best.z) });
  mem.noteVisit(bot.entity.position);
  return r.ok || dist3(me, bot.entity.position) > distance * 0.4 ? ok("moved") : r;
}

/**
 * step: { blocks:[names], accept:[items], count, tool }
 * Mines until `count` more of any accepted item are in the inventory.
 */
const REACH = 4.3;
const eyeOf = (bot) => bot.entity.position.offset(0, 1.62, 0);
const center = (p) => p.offset(0.5, 0.5, 0.5);
// can we hit this block from where we stand without moving? (distance + clear line)
function inReach(bot, pos) {
  const eye = eyeOf(bot);
  if (eye.distanceTo(center(pos)) > REACH) return false;
  const dir = center(pos).minus(eye);
  const hit = bot.world.raycast(eye, dir.normalize(), REACH + 0.5);
  return !!hit && hit.position.x === pos.x && hit.position.y === pos.y && hit.position.z === pos.z;
}

/**
 * step: { blocks:[names], accept:[items], count, tool }
 * Mines until `count` more of any accepted item are in the inventory. Efficient: digs everything in reach without
 * walking, only paths when nothing is in reach, and sweeps up drops once per cluster.
 */
async function mine(ctx, step) {
  const { bot, mem, signal } = ctx;
  if (isLogStep(step)) step = { ...step, blocks: LOGS, accept: [...new Set([...(step.accept || []), ...LOGS])] };     // any wood counts
  const accept = step.accept || [];
  const start = sumInv(bot, accept);
  const target = start + Math.ceil(step.count);
  let fruitless = 0, mined = 0, failures = 0, sinceSweep = 0;
  const SUM = {}; const tStart = Date.now();

  while (sumInv(bot, accept) < target) {
    throwIfAborted(signal);
    ctx.beat?.();
    const T = { t: Date.now() }; const lap = (n) => { SUM[n] = (SUM[n] || 0) + Date.now() - T.t; T.t = Date.now(); };
    const cands = timed("findCandidates", () => findCandidates(ctx, step.blocks), 40); lap("find");
    if (!cands.length) {
      if (sinceSweep) { await collectDrops(ctx, { accept, radius: 8, maxMs: 2500 }); sinceSweep = 0; continue; }
      if (++fruitless > 4) return fail("not_found", { blocks: step.blocks });
      // somebody (me earlier, a teammate) already found some: go there instead of wandering
      const site = knownSites(ctx, step.blocks)[0];
      if (site) {
        log("explore", `going to a known ${resKey(step.blocks)} site at ${site.pos.x},${site.pos.z}`);
        const w = await goto(ctx, new goals.GoalNearXZ(site.pos.x, site.pos.z, 8), { timeout: 60000, dig: false, towardPos: new Vec3(site.pos.x, bot.entity.position.y, site.pos.z) });
        if (!w.ok) mem.banCell(new Vec3(site.pos.x, site.pos.y ?? bot.entity.position.y, site.pos.z), 300000);
        mem.noteVisit(bot.entity.position);
        continue;
      }
      const r = await explore(ctx, { distance: 48 + fruitless * 36, why: "looking for " + step.blocks[0] });
      if (!r.ok && fruitless > 2) return fail("not_found");
      continue;
    }
    if (Date.now() - (ctx._noted || 0) > 30000) { ctx._noted = Date.now(); noteResource(ctx, step.blocks, cands[0].pos); }
    // 1) anything we can hit from right here (nearest first) needs no walking at all
    let c = cands.find((x) => inReach(bot, x.pos));
    if (!c) {
      // nothing in reach: pick up what we dug, then walk to the best candidate
      if (sinceSweep) { await collectDrops(ctx, { accept, radius: 8, maxMs: 2500 }); sinceSweep = 0; }
      c = cands[0];
      const walk = await goto(ctx, new goals.GoalLookAtBlock(c.pos, bot.world, { reach: 4.2 }), { timeout: 45000, towardPos: c.pos }); lap("goto");
      if (!walk.ok) {
        mem.banCell(c.pos, 90000);
        if (++failures >= 6) return fail("unreachable", { last: walk.reason });
        continue;
      }
    }
    const block = bot.blockAt(c.pos);
    if (!block || !step.blocks.includes(block.name)) continue; // already gone
    const before = sumInv(bot, accept);
    const d = await digBlock(ctx, block); lap("dig");
    if (!d.ok) {
      log("mine", `dig failed at ${c.pos} (${block.name}): ${d.reason}`);
      mem.banCell(c.pos, 60000);
      if (++failures >= 6) return fail("dig_failed", { last: d.reason });
      continue;
    }
    mined++; sinceSweep++; failures = 0; fruitless = 0;
    // enough dug blocks on the ground to finish? or a pile building up? sweep now
    if (sinceSweep >= 6 || sumInv(bot, accept) + sinceSweep >= target) { await collectDrops(ctx, { accept, radius: 8, maxMs: 3000 }); sinceSweep = 0; lap("sweep"); }
  }
  // finished inside a pit we dug? climb out like a player would, so the next task starts from open ground
  try { const enc = require("./vertical").enclosure(bot); if (enc.walls >= 3 || enc.ceiling) await require("./vertical").escapeHole(ctx); } catch (e) { if (e.name === "AbortError") throw e; }
  if (process.env.MINE_TRACE) log("mine", `${mined} blocks in ${Date.now() - tStart}ms: ${JSON.stringify(SUM)}`);
  return ok({ mined, gained: sumInv(bot, accept) - start });
}

module.exports = { mine, explore, findCandidates, sumInv, noteResource, knownSites };
