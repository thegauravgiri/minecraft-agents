// Cross-dimension travel: find / build / walk through portals, and chase a player across dimensions.
// One portal crossing per travelDimension call; every wait has a timeout and every retry is counted.
const { Vec3 } = require("vec3");
const { goto, goals } = require("./move");
const { digBlock, placeAt, scaffoldItem } = require("./blocks");
const { normDim } = require("../runtime/observe");
const { sleep, throwIfAborted, waitFor, ok, fail, invCount, dist3, log } = require("../runtime/util");

const PORTAL_WAIT_MS = 15000;
const MAX_ENTER_ATTEMPTS = 3;
const NEED = { obsidian: 10, flint_and_steel: 1 };

const dimOf = (bot) => normDim(bot.game?.dimension);
const isAir = (b) => !!b && b.boundingBox === "empty" && !/lava|water|fire|portal/.test(b.name);
const isFloor = (b) => !!b && b.boundingBox === "block" && b.name !== "magma_block";

/** Pure: what must be acquired before a portal can be built. Empty when a portal is already known. */
function portalMaterialsNeeded(knownPortalsForDimension) {
  return knownPortalsForDimension && knownPortalsForDimension.length ? {} : { ...NEED };
}

function portalsMem(ctx) {
  let p = ctx.mem.recall("portals");
  if (!p) { p = {}; ctx.mem.remember("portals", p); }
  p.overworld = p.overworld || [];
  p.the_nether = p.the_nether || [];
  return p;
}

function recordPortal(ctx, dim, pos) {
  if (dim !== "overworld" && dim !== "the_nether") return;
  const list = portalsMem(ctx)[dim];
  if (list.some((q) => dist3(q, pos) < 6)) return;
  list.push({ x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) });
  log("portal", `remembered ${dim} portal at ${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}`);
}

function forgetPortal(ctx, dim, pos) {
  const p = portalsMem(ctx);
  p[dim] = p[dim].filter((q) => dist3(q, pos) >= 6);
}

/** Loaded portal blocks of kind `name`, nearest first, each moved down to the floor of its column. */
function findPortalBlocks(ctx, name, maxDistance = 128) {
  const { bot } = ctx;
  const def = bot.registry.blocksByName[name];
  if (!def) return [];
  const here = bot.entity.position;
  const seen = new Set();
  const out = [];
  for (const p of bot.findBlocks({ matching: def.id, maxDistance, count: 64 })) {
    let y = p.y;
    while (bot.blockAt(new Vec3(p.x, y - 1, p.z))?.name === name) y--;
    const k = `${p.x},${y},${p.z}`;
    if (seen.has(k)) continue;
    seen.add(k);
    const v = new Vec3(p.x, y, p.z);
    if (ctx.mem.isBanned(v)) continue;
    out.push(v);
  }
  return out.sort((a, b) => a.distanceTo(here) - b.distanceTo(here));
}

function standingSafe(bot) {
  const p = bot.entity.position;
  const feet = bot.blockAt(p), below = bot.blockAt(p.offset(0, -1, 0));
  return bot.entity.onGround && !!feet && !/lava|fire|portal/.test(feet.name) && isFloor(below);
}

/** After a dimension change: wait until chunks are loaded and the bot has landed. */
async function settle(ctx) {
  const { bot, signal } = ctx;
  const loaded = await waitFor(() => bot.entity && bot.blockAt(bot.entity.position.offset(0, -1, 0)) && bot.blockAt(bot.entity.position), { timeout: 12000, interval: 100, signal });
  if (!loaded) return false;
  await waitFor(() => bot.entity.onGround, { timeout: 8000, interval: 100, signal });
  await sleep(500, signal);
  return true;
}

// Leave the portal we arrived in (portal cooldown resets only once we are outside it) onto safe ground.
async function stepOffPortal(ctx) {
  const { bot } = ctx;
  const inPortal = () => /portal/.test(bot.blockAt(bot.entity.position)?.name || "");
  if (!inPortal()) return;
  const here = bot.entity.position.floored();
  const portals = findPortalBlocks(ctx, "nether_portal", 12);
  const cells = [];
  for (let dx = -4; dx <= 4; dx++) for (let dz = -4; dz <= 4; dz++) for (const dy of [0, -1, 1]) {
    const c = here.offset(dx, dy, dz);
    if (!isFloor(bot.blockAt(c.offset(0, -1, 0))) || !isAir(bot.blockAt(c)) || !isAir(bot.blockAt(c.offset(0, 1, 0)))) continue;
    if (portals.some((p) => Math.abs(p.x - c.x) < 2 && Math.abs(p.z - c.z) < 2 && Math.abs(p.y - c.y) < 3)) continue;
    let lava = false;
    for (const [ax, az] of [[1, 0], [-1, 0], [0, 1], [0, -1], [0, 0]]) {
      for (const ay of [-1, 0]) if (/lava/.test(bot.blockAt(c.offset(ax, ay, az))?.name || "")) lava = true;
    }
    if (!lava) cells.push(c);
  }
  cells.sort((a, b) => a.distanceTo(here) - b.distanceTo(here));
  for (const c of cells.slice(0, 3)) {
    const r = await goto(ctx, new goals.GoalBlock(c.x, c.y, c.z), { timeout: 8000, dig: false, towardPos: c });
    if (r.ok && !inPortal()) return;
  }
}

async function onArrival(ctx, fromDim) {
  const { bot } = ctx;
  const dim = dimOf(bot);
  const loaded = await settle(ctx);
  if (!loaded) return fail("arrival_not_loaded", { dimension: dim });
  const here = bot.entity.position;
  if (dim === "overworld" || dim === "the_nether") {
    const ps = findPortalBlocks(ctx, "nether_portal", 10);
    if (ps.length && fromDim !== "the_end") recordPortal(ctx, dim, ps[0]);
  }
  await stepOffPortal(ctx);
  if (!standingSafe(bot)) await waitFor(() => standingSafe(bot), { timeout: 3000, interval: 150, signal: ctx.signal });
  if (!standingSafe(bot)) return fail("unsafe_after_arrival", { dimension: dim, pos: here });
  return ok({ arrived: true, dimension: dim, pos: bot.entity.position.clone() });
}

// Stand in the portal until the dimension changes, nudging back in when pushed out.
async function waitInPortal(ctx, name, target) {
  const { bot, signal } = ctx;
  const dim0 = dimOf(bot);
  const t0 = Date.now();
  bot.clearControlStates();
  while (Date.now() - t0 < PORTAL_WAIT_MS) {
    throwIfAborted(signal);
    ctx.beat?.();
    if (!bot.entity) { await sleep(200, signal); continue; }
    if (dimOf(bot) !== dim0) return true;
    const p = bot.entity.position;
    const inside = bot.blockAt(p)?.name === name || bot.blockAt(p.offset(0, 1, 0))?.name === name;
    if (!inside) {
      await bot.lookAt(new Vec3(target.x + 0.5, p.y + 1.2, target.z + 0.5), true);
      bot.setControlState("forward", true);
      await sleep(180, signal);
      bot.setControlState("forward", false);
    }
    await sleep(200, signal);
  }
  return dimOf(bot) !== dim0;
}

async function enterFrom(ctx, name, fromDim) {
  const { bot } = ctx;
  for (let attempt = 0; attempt < MAX_ENTER_ATTEMPTS; attempt++) {
    throwIfAborted(ctx.signal);
    const cands = findPortalBlocks(ctx, name);
    if (!cands.length) return fail("portal_vanished");
    const t = cands[0];
    if (name === "nether_portal") recordPortal(ctx, fromDim, t);
    const r = await goto(ctx, new goals.GoalBlock(t.x, t.y, t.z), { timeout: 30000, towardPos: t });
    if (!r.ok && bot.entity.position.distanceTo(t.offset(0.5, 0, 0.5)) > 2.5) {
      log("portal", `cannot reach portal at ${t} (${r.reason}), attempt ${attempt + 1}`);
      ctx.mem.banCell(t, 60000);
      continue;
    }
    if (await waitInPortal(ctx, name, t)) return onArrival(ctx, fromDim);
    log("portal", `no warp after ${PORTAL_WAIT_MS}ms, retry ${attempt + 1}`);
    await stepOffPortal(ctx);
  }
  return fail("portal_no_warp");
}

// ---- building ----------------------------------------------------------------------------

function findSite(bot) {
  const o = bot.entity.position.floored();
  const spots = [];
  for (let dx = -8; dx <= 8; dx++) for (let dz = -8; dz <= 8; dz++) spots.push([dx, dz]);
  spots.sort((a, b) => Math.hypot(a[0] + 2, a[1] + 3) - Math.hypot(b[0] + 2, b[1] + 3));
  for (const dy of [0, -1, 1]) for (const [dx, dz] of spots) {
    const px = o.x + dx, z = o.z + dz, py = o.y + dy;
    let good = true;
    for (let x = px; x <= px + 3 && good; x++) {
      if (!isFloor(bot.blockAt(new Vec3(x, py - 1, z)))) good = false;
      for (let y = py; y <= py + 3 && good; y++) if (!isAir(bot.blockAt(new Vec3(x, y, z)))) good = false;
    }
    for (const x of [px + 1, px + 2]) {
      if (!good) break;
      if (!isFloor(bot.blockAt(new Vec3(x, py - 2, z)))) good = false;
      for (const zz of [z + 1, z + 2]) {
        if (!isFloor(bot.blockAt(new Vec3(x, py - 1, zz))) || !isAir(bot.blockAt(new Vec3(x, py, zz))) || !isAir(bot.blockAt(new Vec3(x, py + 1, zz)))) good = false;
      }
    }
    if (good) return { px, py, z };
  }
  return null;
}

async function buildPortal(ctx) {
  const { bot, signal } = ctx;
  const obsidianCount = invCount(bot, "obsidian");
  const igniter = bot.inventory.items().find((i) => i.name === "flint_and_steel") || bot.inventory.items().find((i) => i.name === "fire_charge");
  if (obsidianCount < NEED.obsidian || !igniter) return fail("no_portal_and_no_materials", { need: { ...NEED }, have: { obsidian: obsidianCount, igniter: !!igniter } });
  const scaffold = obsidianCount >= 11 ? null : scaffoldItem(bot, { exclude: ["obsidian"] });
  if (obsidianCount < 11 && !scaffold) return fail("no_portal_and_no_materials", { need: { obsidian: 11 }, have: { obsidian: obsidianCount }, hint: "or any 3 plain blocks for scaffolding" });
  const site = findSite(bot);
  if (!site) return fail("no_flat_site");
  const { px, py, z } = site;
  log("portal", `building frame at ${px},${py},${z}`);
  const obsidian = () => bot.inventory.items().find((i) => i.name === "obsidian");
  const stand = new Vec3(px + 1, py, z + 2);
  const ensureStand = async () => {
    const p = bot.entity.position;
    if (Math.abs(p.x - (px + 1.5)) > 1.6 || Math.abs(p.z - (z + 2.5)) > 1.2 || Math.abs(p.y - py) > 1) {
      return goto(ctx, new goals.GoalBlock(stand.x, stand.y, stand.z), { timeout: 15000, towardPos: stand });
    }
    return ok();
  };
  const put = async (item, x, y, zz) => {
    ctx.beat?.();
    const pos = new Vec3(x, y, zz);
    if (bot.blockAt(pos)?.name === item.name) return ok();
    const g = await ensureStand();
    if (!g.ok) return g;
    const r = await placeAt(ctx, item, pos, { tries: 3 });
    if (!r.ok) return r;
    return bot.blockAt(pos)?.name === item.name ? ok() : fail("wrong_block_placed:" + pos);
  };
  const sequence = async (list, item) => {
    for (const [x, y, zz] of list) {
      const r = await put(typeof item === "function" ? item() : item, x, y, zz);
      if (!r.ok) return r;
    }
    return ok();
  };

  const g0 = await ensureStand();
  if (!g0.ok) return fail("cannot_reach_site", { reason: g0.reason });
  for (const x of [px + 1, px + 2]) {
    const b = bot.blockAt(new Vec3(x, py - 1, z));
    const d = await digBlock(ctx, b);
    if (!d.ok) return fail("site_dig_failed", { reason: d.reason });
  }
  let r = await sequence([[px + 1, py - 1, z], [px + 2, py - 1, z]], obsidian);
  const col = (x) => [[x, py, z], [x, py + 1, z], [x, py + 2, z]];
  if (r.ok) r = await sequence(col(px), obsidian);
  if (r.ok) r = await sequence(col(px + 3), obsidian);
  if (r.ok && !scaffold) r = await sequence([[px, py + 3, z], [px + 1, py + 3, z], [px + 2, py + 3, z]], obsidian);
  if (r.ok && scaffold) {
    const sc = () => bot.inventory.items().find((i) => i.name === scaffold.name);
    r = await sequence(col(px + 1), sc);
    if (r.ok) r = await sequence([[px + 1, py + 3, z], [px + 2, py + 3, z]], obsidian);
    for (const y of [py + 2, py + 1, py]) {
      const b = bot.blockAt(new Vec3(px + 1, y, z));
      if (b && b.name === scaffold.name) { await ensureStand(); await digBlock(ctx, b); }
    }
  }
  if (!r.ok) return fail("frame_placement_failed", { reason: r.reason });

  const want = [[px + 1, py - 1], [px + 2, py - 1], ...[px, px + 3].flatMap((x) => [py, py + 1, py + 2].map((y) => [x, y])), [px + 1, py + 3], [px + 2, py + 3]];
  const missing = want.filter(([x, y]) => bot.blockAt(new Vec3(x, y, z))?.name !== "obsidian");
  if (missing.length) return fail("frame_incomplete", { missing });
  for (const x of [px + 1, px + 2]) for (const y of [py, py + 1, py + 2]) {
    if (!isAir(bot.blockAt(new Vec3(x, y, z)))) return fail("frame_interior_blocked");
  }

  await ensureStand();
  const base = bot.blockAt(new Vec3(px + 1, py - 1, z));
  const lit = () => bot.blockAt(new Vec3(px + 1, py, z))?.name === "nether_portal";
  for (let i = 0; i < 3 && !lit(); i++) {
    await bot.equip(igniter, "hand");
    await bot.lookAt(base.position.offset(0.5, 1, 0.5), true);
    try { await bot.activateBlock(base, new Vec3(0, 1, 0)); } catch (e) { if (e.name === "AbortError") throw e; }
    await waitFor(lit, { timeout: 1500, interval: 100, signal });
  }
  if (!lit()) return fail("portal_not_lit");
  recordPortal(ctx, dimOf(bot), new Vec3(px + 1, py, z));
  return ok({ built: true, at: { x: px + 1, y: py, z } });
}

// ---- public skills -----------------------------------------------------------------------

/**
 * Cross one portal toward `dimension`. Resolves ok({arrived:true, dimension, final}) once the dimension
 * really changed, chunks are loaded and the bot stands safely. `pos` is advisory (target coords in the
 * destination dimension), only used to prefer remembered portals nearer to it.
 */
async function travelDimension(ctx, { dimension, pos } = {}) {
  const { bot } = ctx;
  const target = normDim(dimension);
  const cur = dimOf(bot);
  if (cur === target) return ok({ arrived: true, dimension: cur, final: true, already: true });
  const next = (cur === "the_nether" && target === "the_end") || (cur === "the_end" && target === "the_nether") ? "overworld" : target;
  const endTrip = cur === "the_end" || next === "the_end";
  const name = endTrip ? "end_portal" : "nether_portal";

  let cands = findPortalBlocks(ctx, name);
  if (name === "nether_portal") for (const c of cands.slice(0, 1)) recordPortal(ctx, cur, c);

  if (!cands.length && name === "nether_portal") {
    const known = portalsMem(ctx)[cur].filter((q) => !ctx.mem.isBanned(new Vec3(q.x, q.y, q.z)));
    const here = bot.entity.position;
    known.sort((a, b) => dist3(a, here) - dist3(b, here));
    if (known.length) {
      const q = known[0];
      const d0 = dist3(q, here);
      const r = await goto(ctx, new goals.GoalNear(q.x, q.y, q.z, 4), { timeout: 55000, towardPos: new Vec3(q.x, q.y, q.z) });
      cands = findPortalBlocks(ctx, name);
      if (!cands.length) {
        if (r.ok || dist3(q, bot.entity.position) < 10) forgetPortal(ctx, cur, q);
        else if (dist3(q, bot.entity.position) < d0 - 8) return ok({ arrived: false, moved: true, reason: "en_route_to_portal" });
        else return fail("portal_unreachable", { reason: r.reason });
      }
    }
  }
  if (!cands.length && cur === "the_end" && name === "end_portal") {
    await goto(ctx, new goals.GoalNear(0, bot.entity.position.y, 0, 8), { timeout: 50000, towardPos: new Vec3(0, bot.entity.position.y, 0) });
    cands = findPortalBlocks(ctx, name);
  }

  if (!cands.length) {
    if (name === "end_portal") return fail(cur === "the_end" ? "no_end_exit" : "no_end_portal");
    const b = await buildPortal(ctx);
    if (!b.ok) return b;
    cands = findPortalBlocks(ctx, name, 24);
    if (!cands.length) return fail("built_portal_not_found");
  }

  const r = await enterFrom(ctx, name, cur);
  if (r.ok) r.data.final = r.data.dimension === target;
  return r;
}

/**
 * Chase a player across dimensions. Bounded to ~60s per call so the control loop can re-plan.
 * ok({arrived:true}) when the player is a live entity within 16 blocks, else ok({arrived:false, moved:true}).
 */
async function chaseAcrossDimensions(ctx, playerName) {
  const { bot, signal } = ctx;
  const t0 = Date.now();
  const radar = ctx.agent?.radar;
  if (!radar) return fail("no_radar");
  radar.track(playerName);
  const visibleNear = () => {
    const w = radar.where(playerName);
    return w && w.live && w.sameDimension && w.pos.distanceTo(bot.entity.position) <= 16 ? w : null;
  };
  let crossed = false;
  let w = radar.where(playerName);
  if (!w) {
    const found = await waitFor(() => radar.where(playerName), { timeout: 4000, interval: 200, signal });
    if (!found) return fail("player_unknown");
    w = found;
  }
  if (visibleNear()) return ok({ arrived: true });

  if (!w.sameDimension) {
    const r = await travelDimension(ctx, { dimension: w.dimension, pos: w.pos });
    if (!r.ok) return r;
    crossed = true;
    w = radar.where(playerName);
    if (!w || !w.sameDimension) return ok({ arrived: false, moved: true, crossed });
  }

  while (Date.now() - t0 < 60000) {
    throwIfAborted(signal);
    ctx.beat?.();
    w = radar.where(playerName);
    if (!w || !w.sameDimension) return ok({ arrived: false, moved: true, crossed });
    if (visibleNear()) return ok({ arrived: true, crossed });
    const p = w.pos;
    const r = await goto(ctx, new goals.GoalNear(p.x, p.y, p.z, 4), { timeout: Math.min(30000, 60000 - (Date.now() - t0)), towardPos: p });
    if (visibleNear()) return ok({ arrived: true, crossed });
    if (!r.ok && r.reason !== "timeout") return ok({ arrived: false, moved: true, crossed, reason: r.reason });
    if (r.ok) await sleep(400, signal);
  }
  return ok({ arrived: false, moved: true, crossed });
}

module.exports = { travelDimension, portalMaterialsNeeded, chaseAcrossDimensions, buildPortal, findPortalBlocks, recordPortal };
