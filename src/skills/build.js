// Build a house and PROVE it stands: the world is diffed against a pure blueprint before, during and after,
// the site is remembered so an interrupted build resumes the same house, and success is only reported when the
// independent verifier passes on the real blocks. Never digs or scaffolds with pathfinder inside the build.
const { Vec3 } = require("vec3");
const { goals, configureMovements } = require("./move");
const { digBlock, placeAt, scaffoldItem, collectDrops } = require("./blocks");
const { sleep, throwIfAborted, waitFor, ok, fail, log, invMap, dist3 } = require("../runtime/util");
const BP = require("../core/blueprint");

const vec = (p) => new Vec3(p.x, p.y, p.z);
const mkAt = (bot) => (p) => { const b = bot.blockAt(vec(p)); return b ? { name: b.name, boundingBox: b.boundingBox } : null; };
const cellSig = (c) => `house:cell:${c.x},${c.y},${c.z}`;
const MAX_STRIKES = 4;

// Movements that never break or scaffold with build material: planks, glass, doors stay untouched.
function safeMovements(bot, terrain) {
  const m = configureMovements(bot, { dig: terrain, scaffold: terrain });
  // never walk on tilled soil: stepping/jumping onto farmland turns it back into dirt
  m.exclusionAreasStep.push((block) => (block?.position && bot.blockAt(block.position.offset(0, -1, 0))?.name === "farmland" ? 1000 : 0));
  const keep = (n) => /(_planks|glass|_door|torch)$/.test(n);
  for (const [n, b] of Object.entries(bot.registry.blocksByName)) if (keep(n)) m.blocksCantBreak.add(b.id);
  m.scafoldingBlocks = m.scafoldingBlocks.filter((id) => !keep(bot.registry.items[id]?.name || ""));
  return m;
}

async function walk(ctx, goal, opts = {}) {
  const r = await walkOnce(ctx, goal, opts, false);
  if (r.ok || (r.reason !== "no_path" && r.reason !== "stuck")) return r;
  return walkOnce(ctx, goal, opts, true);
}

async function walkOnce(ctx, goal, { timeout = 20000 } = {}, terrain = false) {
  const { bot, signal } = ctx;
  throwIfAborted(signal);
  const reached = () => { try { return goal.isEnd(bot.entity.position.floored()); } catch { return false; } };
  if (reached()) return ok("already");
  bot.pathfinder.setMovements(safeMovements(bot, terrain));
  let noPath = false, noPathSince = 0;
  const onUpdate = (r) => { noPath = r.status === "noPath"; };
  bot.on("path_update", onUpdate);
  bot.pathfinder.setGoal(goal);
  const t0 = Date.now();
  let anchor = bot.entity.position.clone(), anchorT = t0, hops = 0;
  try {
    for (;;) {
      await sleep(100, signal);
      ctx.beat?.();
      if (reached()) return ok("reached");
      const now = Date.now();
      if (now - t0 > timeout) return fail("timeout");
      if (noPath) { if (!noPathSince) noPathSince = now; if (now - noPathSince > 1200) return fail("no_path"); } else noPathSince = 0;
      if (dist3(bot.entity.position, anchor) > 0.5) { anchor = bot.entity.position.clone(); anchorT = now; }
      else if (now - anchorT > 2500) {
        if (++hops > 3) return fail("stuck");
        bot.setControlState("jump", true); await sleep(300, signal); bot.setControlState("jump", false);
        bot.pathfinder.setGoal(goal);
        anchorT = Date.now();
      }
    }
  } finally {
    bot.removeListener("path_update", onUpdate);
    try { bot.pathfinder.stop(); } catch {}
  }
}

const solidAt = (bot, p) => BP.isSolid(mkAt(bot)(p));
const standable = (bot, p) => solidAt(bot, { x: p.x, y: p.y - 1, z: p.z }) && BP.isPassable(mkAt(bot)(p)) && BP.isPassable(mkAt(bot)({ x: p.x, y: p.y + 1, z: p.z }));

// Get within reach of `cell` without standing in its column.
async function reachCell(ctx, cell, maxDist = 4.2) {
  const { bot } = ctx;
  const target = new Vec3(cell.x + 0.5, cell.y + 0.5, cell.z + 0.5);
  const inCol = () => { const f = bot.entity.position.floored(); return f.x === cell.x && f.z === cell.z && (f.y === cell.y || f.y + 1 === cell.y); };
  const near = () => bot.entity.position.offset(0, 1.62, 0).distanceTo(target) <= maxDist;
  if (near() && !inCol()) return ok();
  if (bot.game?.gameMode === "creative") {                       // creative builders hover; no pathfinding, no pillars
    const cr = require("./creative");
    for (let i = 0; i < 2; i++) { await cr.hoverNear(ctx, cell, maxDist); if (near() && !inCol()) return ok(); }
  }
  const r = await walk(ctx, new goals.GoalNear(target.x, target.y, target.z, 3), { timeout: 15000 });
  if (near() && !inCol()) return ok();
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) for (const dy of [0, -1, 1]) {
    const p = { x: cell.x + dx, y: cell.y + dy, z: cell.z + dz };
    if (!standable(bot, p)) continue;
    const w = await walk(ctx, new goals.GoalBlock(p.x, p.y, p.z), { timeout: 8000 });
    if (w.ok && near() && !inCol()) return ok();
  }
  return fail(r.ok ? "cannot_reach" : r.reason);
}

function surfaceOf(at, x, z, aroundY) {
  for (let y = aroundY + 8; y >= aroundY - 10; y--) {
    const b = at({ x, y, z });
    if (!b) return { bad: "unloaded" };
    if (y === aroundY + 8 && b.boundingBox === "block") return { bad: "too_high" };
    if (BP.isFluid(b)) return { bad: "fluid" };
    if (/(_log|_wood|_stem)$/.test(b.name)) return { bad: "tree" };
    if (b.boundingBox === "block" && !/leaves/.test(b.name)) return { y };
  }
  return { bad: "no_ground" };
}

// Pick a flat-ish, dry, tree-free footprint near the bot.
function chooseSite(bot, size, door) {
  const at = mkAt(bot);
  const { w, d } = size;
  const bx = Math.floor(bot.entity.position.x), bz = Math.floor(bot.entity.position.z), by = Math.floor(bot.entity.position.y);
  const cands = [[3, -2]];
  for (const r of [7, 11, 15]) for (let i = 0; i < 8; i++) cands.push([Math.round(Math.cos(i * Math.PI / 4) * r) + 2, Math.round(Math.sin(i * Math.PI / 4) * r)]);
  let best = null; const why = {};
  for (const [dx, dz] of cands) {
    const ox = bx + dx, oz = bz + dz;
    const dir = BP.DIRS[door] || BP.DIRS.south;
    const cols = [];
    for (let x = ox - 1; x <= ox + w; x++) for (let z = oz - 1; z <= oz + d; z++) cols.push([x, z]);
    let bad = null; const ys = [];
    for (const [x, z] of cols) {
      const s = surfaceOf(at, x, z, by);
      if (s.bad) { bad = s.bad; break; }
      if (x >= ox && x < ox + w && z >= oz && z < oz + d) ys.push(s.y);
    }
    if (bad) { why[bad] = (why[bad] || 0) + 1; continue; }
    const sorted = ys.slice().sort((a, b) => a - b);
    const y0 = sorted[Math.floor(sorted.length / 2)];
    if (require("../runtime/spatial").builtInside(bot, ox, oz, w, d, y0) > 3) { why.built = (why.built || 0) + 1; continue; }     // never on top of somebody's house
    const dev = ys.map((y) => Math.abs(y - y0));
    if (Math.max(...dev) > 3) { why.uneven = (why.uneven || 0) + 1; continue; }
    const cost = dev.reduce((a, b) => a + b, 0);
    const score = cost + Math.hypot(dx, dz) * 0.5;
    if (!best || score < best.score) best = { score, origin: { x: ox, y: y0, z: oz }, cost };
  }
  if (!best) require("../runtime/util").log("site", `no site for ${w}x${d} around ${bx},${by},${bz}: ${JSON.stringify(why)}`);
  return best;
}

const resolveMaterial = (inv, wanted) => {
  if (wanted && wanted !== "planks") return wanted;
  let best = "oak_planks", n = 0;
  for (const [k, v] of Object.entries(inv)) if (/_planks$/.test(k) && v > n) { best = k; n = v; }
  return best;
};

function pickItem(bot, rec, role) {
  const items = bot.inventory.items();
  const byName = (n) => items.find((i) => i.name === n);
  if (role === "window") return byName("glass");
  if (role === "torch") return byName("torch");
  const exact = byName(rec.material);
  if (exact) return exact;
  if (/_planks$/.test(rec.material)) return items.filter((i) => /_planks$/.test(i.name)).sort((a, b) => b.count - a.count)[0];
  return null;
}
const needFor = (rec, role, n) => ({ [role === "window" ? "glass" : rec.material]: n });

function fillerItem(bot, rec) {
  const exclude = [rec.material];
  for (let i = 0; i < 20; i++) {
    const it = scaffoldItem(bot, { exclude });
    if (!it) return null;
    if (/(planks|glass|_door|torch|_log|_wood)/.test(it.name)) { exclude.push(it.name); continue; }
    return it;
  }
  return null;
}

async function clearObstructions(ctx, bp, at) {
  const { bot, mem } = ctx;
  for (let pass = 0; pass < 3; pass++) {
    const obs = BP.obstructions(bp, at).filter((o) => !BP.isFluid(o.name) && mem.strikesOf(cellSig(o)) < MAX_STRIKES);
    if (!obs.length) { await collectDrops(ctx, { radius: 10, maxMs: 6000 }); return ok(); }
    for (const o of obs) {
      throwIfAborted(ctx.signal); ctx.beat?.();
      const b = bot.blockAt(vec(o));
      if (!b || BP.isAir(b)) continue;
      const r = await reachCell(ctx, o);
      const d = r.ok ? await digBlock(ctx, bot.blockAt(vec(o))) : r;
      if (!d.ok) { mem.strike(cellSig(o)); log("build", `cannot clear ${o.name}@${o.x},${o.y},${o.z}: ${d.reason}`); }
    }
  }
  await collectDrops(ctx, { radius: 10, maxMs: 6000 });
  const left = BP.obstructions(bp, at).filter((o) => !BP.isFluid(o.name));
  return left.length ? fail("site_blocked", { cells: left.slice(0, 8) }) : ok();
}

async function fillFloor(ctx, rec, bp, at) {
  const { bot, mem } = ctx;
  for (let pass = 0; pass < 3; pass++) {
    const { fills, unsupported } = BP.fillPlan(bp, at);
    if (unsupported.length) return fail("unsupported_site", { cells: unsupported.slice(0, 5) });
    if (!fills.length) return ok();
    for (const c of fills) {
      throwIfAborted(ctx.signal); ctx.beat?.();
      if (BP.isSolidGood(at(c))) continue;
      const item = fillerItem(bot, rec);
      if (!item) return fail("need_materials", { need: { dirt: BP.fillPlan(bp, at).fills.length } });
      if (mem.strikesOf(cellSig(c)) >= MAX_STRIKES) continue;
      const r = await reachCell(ctx, c);
      const p = r.ok ? await placeAt(ctx, item, vec(c)) : r;
      if (!p.ok || !BP.isSolidGood(at(c))) mem.strike(cellSig(c));
    }
  }
  const left = BP.fillPlan(bp, at).fills;
  return left.length ? fail("fill_failed", { cells: left.slice(0, 8) }) : ok();
}

async function placeShell(ctx, rec, bp, at) {
  const { bot, mem } = ctx;
  let placedCount = 0;
  for (let pass = 0; pass < 6; pass++) {
    const d = BP.diffBlueprint(bp, at);
    const todo = d.missing.concat(d.wrong.filter((c) => c.role !== "interior")).filter((c) => !c.role.startsWith("door") && mem.strikesOf(cellSig(c)) < MAX_STRIKES);
    if (!todo.length) return ok({ placed: placedCount });
    const { order, stuck } = BP.orderCells(todo, bp.stand, { solid: (p) => BP.isSolid(at(p)) });
    if (!order.length) return fail("unplaceable", { cells: stuck.slice(0, 6) });
    for (const step of order) {
      throwIfAborted(ctx.signal); ctx.beat?.();
      const c = step.cell;
      if (BP.cellState(c, at(c), bp) === "ok") continue;
      const item = pickItem(bot, rec, c.role);
      if (!item) return fail("need_materials", { need: needFor(rec, c.role, todo.length), placed: placedCount });
      const n = mem.strikesOf(cellSig(c));
      const cands = BP.standsFor(c, bp.stand);
      const stand = cands[n % cands.length] || step.stand;
      const f = bot.entity.position.floored();
      const onStand = cands.some((s) => s.x === f.x && s.z === f.z && Math.abs(s.y - bot.entity.position.y) < 0.6);
      if (!onStand) {
        const w = await walk(ctx, new goals.GoalBlock(stand.x, stand.y, stand.z), { timeout: 15000 });
        if (!w.ok) { mem.strike(cellSig(c)); log("build", `walk to stand failed (${w.reason})`); continue; }
      }
      const r = await placeAt(ctx, item, vec(c));
      if (r.ok && BP.cellState(c, at(c), bp) === "ok") { placedCount++; continue; }
      const strikes = mem.strike(cellSig(c));
      log("build", `place ${c.role}@${c.x},${c.y},${c.z} failed (#${strikes}): ${r.reason || "state"}`);
    }
  }
  const d = BP.diffBlueprint(bp, at);
  const left = d.missing.concat(d.wrong).filter((c) => !c.role.startsWith("door") && c.role !== "interior");
  return left.length ? fail("place_failed", { cells: left.slice(0, 8), placed: placedCount }) : ok({ placed: placedCount });
}

async function placeTorch(ctx, bp, at) {
  const { bot } = ctx;
  const t = bp.cells.find((c) => c.role === "torch");
  const item = bot.inventory.items().find((i) => i.name === "torch");
  if (!t || !item || BP.isTorch(at(t))) return;
  const w = await walk(ctx, new goals.GoalBlock(bp.stand[0].x, bp.stand[0].y, bp.stand[0].z), { timeout: 10000 });
  if (!w.ok) return;
  try {
    const ref = bot.blockAt(vec(t).offset(0, -1, 0));
    if (!ref || ref.boundingBox !== "block") return;
    await bot.equip(item, "hand");
    await bot.lookAt(ref.position.offset(0.5, 1, 0.5), true);
    await bot.placeBlock(ref, new Vec3(0, 1, 0));
    await sleep(150, ctx.signal);
  } catch (e) { if (e.name === "AbortError") throw e; }
}

const doorItemOf = (bot) => bot.inventory.items().find((i) => /_door$/.test(i.name) && i.name !== "iron_door");

// Leave through the doorway, then hang the door from outside so the bot is never sealed in.
async function finishDoor(ctx, bp, at) {
  const { bot, mem } = ctx;
  const have = BP.isDoor(at(bp.doorCell)) && BP.isDoor(at(bp.doorUpper));
  if (!have && !doorItemOf(bot)) return fail("need_materials", { need: { [bp.doorItem]: 1 } });
  const f = bp.front;
  let w = await walk(ctx, new goals.GoalBlock(f.x, f.y, f.z), { timeout: 20000 });
  if (!w.ok && have) {
    const door = bot.blockAt(vec(bp.doorCell));
    try { await bot.activateBlock(door); await sleep(300, ctx.signal); } catch (e) { if (e.name === "AbortError") throw e; }
    w = await walk(ctx, new goals.GoalBlock(f.x, f.y, f.z), { timeout: 20000 });
  }
  if (!w.ok) return fail("cannot_exit", { reason: w.reason });
  if (have) return ok("door_present");
  const sig = "house:door";
  for (let i = 0; i < 4; i++) {
    throwIfAborted(ctx.signal);
    const item = doorItemOf(bot);
    if (!item) return fail("need_materials", { need: { [bp.doorItem]: 1 } });
    const ref = bot.blockAt(vec(bp.doorCell).offset(0, -1, 0));
    if (!ref || ref.boundingBox !== "block") return fail("door_no_floor");
    try {
      await bot.equip(item, "hand");
      await bot.lookAt(ref.position.offset(0.5, 1, 0.5), true);
      await bot.placeBlock(ref, new Vec3(0, 1, 0));
    } catch (e) { if (e.name === "AbortError") throw e; mem.strike(sig); }
    const good = await waitFor(() => BP.isDoor(at(bp.doorCell)) && BP.isDoor(at(bp.doorUpper)), { timeout: 1200, interval: 40, signal: ctx.signal });
    if (good) return ok("door_placed");
    await sleep(200, ctx.signal);
  }
  return fail("door_failed");
}

/**
 * buildHouse(ctx, { origin?, size?:{w,d,h}, material?, door?, windows?, fresh? })
 * Resumes mem.recall('house') unless `fresh` or an explicit `origin` is given.
 * ok({verified:true, origin, size, door}) only when verifyHouse passes on the real world.
 * fail reasons: need_materials{need}, no_site, site_blocked, place_failed{cells}, cannot_exit, verify_failed{problems}.
 */
async function buildHouse(ctx, args = {}) {
  const { bot, mem } = ctx;
  const at = mkAt(bot);
  let placed = 0;
  try {
    throwIfAborted(ctx.signal);
    let rec = mem.recall("house");
    if (!rec || args.fresh || args.origin) {
      const inv = invMap(bot);
      const size = { w: args.size?.w ?? 5, d: args.size?.d ?? 5, h: args.size?.h ?? 3 };
      const door = args.door || "south";
      let origin = args.origin;
      if (!origin) {
        const site = chooseSite(bot, { w: Math.max(5, size.w), d: Math.max(5, size.d) }, door);
        if (!site) return fail("no_site");
        origin = site.origin;
        log("build", `site ${JSON.stringify(origin)} cost ${site.cost}`);
      }
      const windows = args.windows || ((inv.glass || 0) >= 2 ? "glass" : "none");
      rec = { origin, size, material: resolveMaterial(inv, args.material), door, windows, torch: (inv.torch || 0) > 0, verified: false };
      mem.remember("house", rec);
    }
    const bp = BP.houseBlueprint(rec);
    rec.size = bp.size; rec.windows = bp.windows;

    const pre = BP.verifyHouse(bp, at);
    if (pre.ok && rec.verified) return ok({ verified: true, origin: bp.origin, size: bp.size, door: bp.doorCell, resumed: true });
    rec.verified = false;

    const need = BP.materialsNeeded(bp, invMap(bot), at, { ignoreFloor: true });
    if (Object.keys(need).length) return fail("need_materials", { need, house: rec });

    const c = bp.box.min;
    const centre = { x: c.x + bp.size.w / 2, y: bp.origin.y + 1, z: c.z + bp.size.d / 2 };
    if (Math.hypot(bot.entity.position.x - centre.x, bot.entity.position.z - centre.z) > 14) {
      let w = await walk(ctx, new goals.GoalNear(bp.front.x, bp.front.y, bp.front.z, 3), { timeout: 60000 });
      if (!w.ok) w = await require("./move").goto(ctx, new goals.GoalNear(bp.front.x, bp.front.y, bp.front.z, 3), { timeout: 60000, dig: true });
      if (!w.ok) return fail("cannot_reach_site", { reason: w.reason });
    }

    let last = null;
    for (let round = 0; round < 3; round++) {
      let r = await clearObstructions(ctx, bp, at); if (!r.ok) return r;
      r = await fillFloor(ctx, rec, bp, at); if (!r.ok) return r;
      r = await placeShell(ctx, rec, bp, at); if (!r.ok) return r;
      placed += r.data?.placed || 0;
      if (rec.torch !== false) await placeTorch(ctx, bp, at);
      r = await finishDoor(ctx, bp, at); if (!r.ok) return r;
      last = BP.verifyHouse(bp, at);
      if (last.ok) {
        rec.verified = true;
        mem.clearStrikes("house:");
        return { ...ok({ verified: true, origin: bp.origin, size: bp.size, door: bp.doorCell, front: bp.front, placed }), progress: { blocks: placed } };
      }
      log("build", `verify failed round ${round}: ${last.problems.slice(0, 5).join(" ")}`);
    }
    return fail("verify_failed", { problems: last.problems });
  } finally {
    for (const k of ["forward", "back", "left", "right", "jump", "sprint", "sneak"]) bot.setControlState(k, false);
    try { bot.pathfinder.stop(); } catch {}
  }
}

module.exports = { buildHouse, chooseSite, walk, reachCell, standable, surfaceOf };
