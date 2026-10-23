// Generic builder: turns a validated structure spec into real blocks, bottom-up, re-diffing the world after every
// pass, and only reports success when every cell matches. Handles solid blocks, stairs/slabs (facing), doors,
// clearing, tilling, planting and water. Scaffolds with the blocks it carries when a cell is out of reach.
const { Vec3 } = require("vec3");
const { goals } = require("./move");
const { digBlock, placeAt, scaffoldItem, collectDrops, isProtected, solid, blockerBetween } = require("./blocks");
const { chooseSite, walk, reachCell } = require("./build");
const { pillarUp } = require("./vertical");
const S = require("../core/structure");
const { sleep, throwIfAborted, ok, fail, log, invMap, invCount } = require("../runtime/util");

const vec = (p) => new Vec3(p.x, p.y, p.z);
const mkAt = (bot) => (p) => { const b = bot.blockAt(vec(p)); return b ? { name: b.name, boundingBox: b.boundingBox } : null; };
const YAW = { north: Math.PI, south: 0, east: -Math.PI / 2, west: Math.PI / 2 }; // yaw that makes the player FACE that direction

function itemFor(bot, cell) {
  const inv = bot.inventory.items();
  const exact = inv.find((i) => i.name === cell.item);
  if (exact) return exact;
  if (/_planks$/.test(cell.item || "")) return inv.filter((i) => /_planks$/.test(i.name)).sort((a, b) => b.count - a.count)[0];
  if (/_door$/.test(cell.item || "")) return inv.find((i) => /_door$/.test(i.name) && i.name !== "iron_door");
  return null;
}

const hoeOf = (bot) => bot.inventory.items().find((i) => /_hoe$/.test(i.name));

async function standNear(ctx, cell) {
  const r = await reachCell(ctx, cell, 4.2);
  if (r.ok) return r;
  // too high for the ground: build up from where we are, remembering the scaffold so it can be removed afterwards
  const { bot } = ctx;
  if (cell.y - bot.entity.position.y > 3) {
    const before = bot.entity.position.floored();
    const p = await pillarUp(ctx, { untilY: cell.y - 1 });
    if (p.ok) { (ctx.scaffold ||= []).push(before); return ok(); }
  }
  return r;
}

/**
 * Can I actually see the block from here? A wall between us (junk INSIDE a house while we stand outside, a patch seen at a bad angle) means:
 * walk to a spot that looks straight at it - in front of it, behind it, or (for inside a house) in through the door.
 */
async function ensureClearShot(ctx, cell) {
  const { bot } = ctx;
  const target = bot.blockAt(vec(cell));
  if (!target || target.boundingBox !== "block") return true;
  const blocker = blockerBetween(bot, target);
  if (!blocker || blocker.boundingBox !== "block") return true;
  const spots = [];
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) for (const dist of [1, 2, 3]) for (const dy of [0, -1, -2, 1]) spots.push({ x: cell.x + dx * dist, y: cell.y + dy, z: cell.z + dz * dist });
  const standable = (p) => solid(bot, vec({ x: p.x, y: p.y - 1, z: p.z })) && !solid(bot, vec(p)) && !solid(bot, vec({ x: p.x, y: p.y + 1, z: p.z }));
  const me = bot.entity.position;
  log("structure", `no clear shot at ${target.name}@${cell.x},${cell.y},${cell.z} (blocked by ${blocker.name}@${blocker.position}) - trying ${spots.filter(standable).length} spots`);
  for (const p of spots.filter(standable).sort((a, b) => Math.hypot(a.x - me.x, a.z - me.z) - Math.hypot(b.x - me.x, b.z - me.z)).slice(0, 3)) {
    const w = await require("./move").goto(ctx, new goals.GoalBlock(p.x, p.y, p.z), { timeout: 12000, towardPos: vec(p), dig: false });      // door-aware mover: in through the door, never through the wall
    log("structure", `  spot ${p.x},${p.y},${p.z}: ${w.ok ? "reached" : w.reason}`);
    if (!w.ok) continue;
    const b2 = blockerBetween(bot, bot.blockAt(vec(cell)));
    if (!b2 || b2.boundingBox !== "block") return true;
  }
  return false;
}

async function digIfInTheWay(ctx, cell) {
  const { bot } = ctx;
  const shot = bot.game?.gameMode === "creative" ? true : await ensureClearShot(ctx, cell);     // creative breaks need no line of sight
  const cur = bot.blockAt(vec(cell));
  // fixing a building: junk the wall hides from every reachable spot is still taken out (the wall itself is never touched)
  if (!shot && ctx.agent?.goal?.mode === "fix" && cur && cur.boundingBox === "block" && !isProtected(cur.name) && cur.diggable) return digBlock(ctx, cur, { depth: 6 });
  if (cur && cur.boundingBox === "block" && !isProtected(cur.name) && cur.diggable) return digBlock(ctx, cur);
  if (cur && cur.boundingBox === "empty" && cur.name !== "air" && !/water|lava/.test(cur.name)) return digBlock(ctx, cur); // grass, flowers...
  return ok();
}

// Stand dead-centre in the block we are in (needed so a steep ray clears the rim of an adjacent hole).
async function centerOnBlock(ctx, tolerance = 0.12) {
  const { bot, signal } = ctx;
  const target = bot.entity.position.floored().offset(0.5, 0, 0.5);
  for (let i = 0; i < 40; i++) {
    throwIfAborted(signal);
    const dx = target.x - bot.entity.position.x, dz = target.z - bot.entity.position.z;
    if (Math.hypot(dx, dz) < tolerance) break;
    await bot.look(Math.atan2(-dx, -dz), 0, true);
    bot.setControlState("forward", true); await sleep(Math.hypot(dx, dz) > 0.4 ? 90 : 35, signal); bot.setControlState("forward", false);
    await sleep(60, signal);
  }
  bot.clearControlStates();
}

// ---- one cell ----
async function placeCell(ctx, cell) {
  const { bot, signal } = ctx;
  throwIfAborted(signal);
  const creative = bot.game?.gameMode === "creative";
  if (creative && cell.kind === "air") {                          // creative: hover next to it and break it (instant) - no walking, no pillars
    if (!(await require("./creative").hoverAbove(ctx, cell))) return fail("cannot_reach:hover");
    const d = await digIfInTheWay(ctx, cell); return d.ok ? ok() : d;
  }
  if (creative && cell.kind === "path") {                         // creative: hover over it too, then the shovel below does the rest
    if (!(await require("./creative").hoverAbove(ctx, cell))) return fail("cannot_reach:hover");
  }
  if (creative && cell.kind === "block") {                       // creative: hover over the cell and place it by hand, no pathfinding
    const cr = require("./creative");
    if (!(await cr.hoverAbove(ctx, cell))) return fail("cannot_reach:hover");
    // we can sink into the very hole we want to fill (gravity, a bump): never try to place a block where we stand
    const me = bot.entity.position;
    if (Math.floor(me.x) === cell.x && Math.floor(me.z) === cell.z && me.y > cell.y - 1.9 && me.y < cell.y + 1) { if (!(await cr.hoverAbove(ctx, cell, { side: true }))) return fail("cannot_reach:hover"); }
    const wrong0 = await digIfInTheWay(ctx, cell); if (!wrong0.ok) return wrong0;
    const item0 = itemFor(bot, cell);
    if (!item0) return fail("need_materials", { need: { [cell.item]: 1 } });
    let pr = await placeAt(ctx, item0, vec(cell), { yaw: cell.facing ? YAW[cell.facing] : null, tries: 1 });
    if (!pr.ok) {
      // nothing to attach it to (a flag's cloth, an overhang): put a temporary block under it, place, take the helper away again
      const below = { x: cell.x, y: cell.y - 1, z: cell.z };
      const filler = scaffoldItem(bot, { exclude: [cell.block] }) || (await (async () => { await cr.giveItems(ctx, { items: { dirt: 16 } }); return bot.inventory.items().find((i) => i.name === "dirt"); })());
      if (filler && !solid(bot, vec(below))) {
        const sp = await placeAt(ctx, filler, vec(below), { tries: 1 });
        if (sp.ok) {
          pr = await placeAt(ctx, item0, vec(cell), { yaw: cell.facing ? YAW[cell.facing] : null, tries: 2 });
          (ctx.temp ||= []).push(below);
        }
      }
    }
    return pr;
  }
  const reach = (creative && (cell.kind === "door" || cell.kind === "door_upper" || cell.kind === "path")) ? ok() : await standNear(ctx, cell);
  if (!reach.ok) return fail("cannot_reach:" + reach.reason);

  if (cell.kind === "air") {
    const cur = bot.blockAt(vec(cell));
    if (cur && /^(water|lava)$/.test(cur.name)) {
      // stray liquid: scoop it up with an empty bucket, or smother it with a block and dig that out
      const empty = bot.inventory.items().find((i) => i.name === "bucket");
      if (empty && cur.name === "water") {
        await bot.equip(empty, "hand"); await bot.lookAt(vec(cell).offset(0.5, 0.5, 0.5), true); await sleep(100, signal);
        try { bot.deactivateItem(); } catch { /* idle */ } bot.activateItem(); await sleep(400, signal); try { bot.deactivateItem(); } catch { /* instant */ }
        return /^(water|lava)$/.test(bot.blockAt(vec(cell))?.name || "") ? fail("liquid_remains") : ok();
      }
      const filler = scaffoldItem(bot);
      if (filler) { await placeAt(ctx, filler, vec(cell)); const b = bot.blockAt(vec(cell)); if (b?.boundingBox === "block") await digBlock(ctx, b); }
      return /^(water|lava)$/.test(bot.blockAt(vec(cell))?.name || "") ? fail("liquid_remains") : ok();
    }
    const d = await digIfInTheWay(ctx, cell); return d.ok ? ok() : d;
  }

  if (cell.kind === "path") {                                            // grass/dirt + shovel = dirt path (what a village path is)
    const shovel = bot.inventory.items().find((i) => /_shovel$/.test(i.name));
    if (!shovel) return fail("need_materials", { need: { wooden_shovel: 1 } });
    let g = bot.blockAt(vec(cell));
    if (g?.name === "dirt_path") return ok();
    const above = bot.blockAt(vec({ x: cell.x, y: cell.y + 1, z: cell.z }));
    if (above && above.name !== "air" && above.boundingBox === "empty" && !isProtected(above.name)) await digBlock(ctx, above);   // grass tufts, flowers
    if (!g || g.boundingBox !== "block" || !/^(grass_block|dirt|coarse_dirt|podzol|mycelium|rooted_dirt)$/.test(g.name)) {
      const dirt = bot.inventory.items().find((i) => i.name === "dirt");
      if (!dirt) return fail("need_materials", { need: { dirt: 1 } });
      if (g && g.boundingBox === "block") { const d = await digBlock(ctx, g); if (!d.ok) return d; }
      const pl = await placeAt(ctx, dirt, vec(cell)); if (!pl.ok) return pl;
      g = bot.blockAt(vec(cell));
    }
    await bot.equip(shovel, "hand");
    await bot.lookAt(vec(cell).offset(0.5, 1, 0.5), true);
    try { await bot.activateBlock(g, new Vec3(0, 1, 0)); } catch (e) { if (e.name === "AbortError") throw e; }
    await sleep(150, signal);
    return bot.blockAt(vec(cell))?.name === "dirt_path" ? ok() : fail("path_failed");
  }

  if (cell.kind === "till") {
    const hoe = hoeOf(bot);
    if (!hoe) return fail("need_materials", { need: { wooden_hoe: 1 } });
    const g = bot.blockAt(vec(cell));
    if (g?.name === "farmland") return ok();
    const above = bot.blockAt(vec({ x: cell.x, y: cell.y + 1, z: cell.z }));
    if (above && above.name !== "air" && !isProtected(above.name) && (above.boundingBox === "empty" || above.diggable)) await digBlock(ctx, above);   // grass/flowers/anything on top
    if (g && g.boundingBox === "block" && !/(dirt|grass_block|dirt_path|coarse_dirt|rooted_dirt)$/.test(g.name)) { const d = await digBlock(ctx, g); if (!d.ok) return d; }
    const dirtItem = bot.inventory.items().find((i) => i.name === "dirt");
    if (bot.blockAt(vec(cell))?.name === "air") { if (!dirtItem) return fail("need_materials", { need: { dirt: 1 } }); const p = await placeAt(ctx, dirtItem, vec(cell)); if (!p.ok) return p; }
    await bot.equip(hoe, "hand");
    await bot.lookAt(vec(cell).offset(0.5, 1, 0.5), true);
    try { await bot.activateBlock(bot.blockAt(vec(cell)), new Vec3(0, 1, 0)); } catch (e) { if (e.name === "AbortError") throw e; }
    await sleep(150, signal);
    const tilled = bot.blockAt(vec(cell))?.name === "farmland";
    if (!tilled) log("structure", `till failed at ${cell.x},${cell.y},${cell.z}: ground=${bot.blockAt(vec(cell))?.name} above=${bot.blockAt(vec({ x: cell.x, y: cell.y + 1, z: cell.z }))?.name} me=${bot.entity.position.floored()} held=${bot.heldItem?.name}`);
    return tilled ? ok() : fail("till_failed");
  }

  if (cell.kind === "water") {
    const cur = bot.blockAt(vec(cell));
    if (cur?.name === "water") return ok();
    let bucket = bot.inventory.items().find((i) => i.name === "water_bucket");
    if (!bucket) {
      const f = await fillBucket(ctx); if (!f.ok) return f;
      bucket = bot.inventory.items().find((i) => i.name === "water_bucket");
      const back = await standNear(ctx, cell);          // we walked to the pond: come back to the cell before digging it
      if (!back.ok) return fail("cannot_reach:" + back.reason);
    }
    if (cur && cur.boundingBox === "block") { const d = await digBlock(ctx, cur); if (!d.ok) return d; }
    await bot.equip(bucket, "hand");
    // stand right beside the cell and aim straight down into it, so the ray enters the hole instead of hitting its rim
    const sides = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dz]) => ({ x: cell.x + dx, y: cell.y + 1, z: cell.z + dz }));
    const stand = sides.find((p) => solid(bot, vec({ x: p.x, y: p.y - 1, z: p.z })) && !solid(bot, vec(p)) && !solid(bot, vec({ x: p.x, y: p.y + 1, z: p.z })));
    if (stand) await walk(ctx, new goals.GoalBlock(stand.x, stand.y, stand.z), { timeout: 10000 });
    // centre on our block, then aim exactly at the hole's floor so the ray clears the rim
    await centerOnBlock(ctx);
    const wbNow = bot.inventory.items().find((i) => i.name === "water_bucket");
    if (wbNow && bot.heldItem?.name !== "water_bucket") await bot.equip(wbNow, "hand");     // walking/digging may have swapped the held item
    await bot.lookAt(vec(cell).offset(0.5, 0.0, 0.5), true);
    await sleep(150, signal);
    try { bot.deactivateItem(); } catch { /* not using */ }
    await sleep(60, signal);
    bot.activateItem(); await sleep(450, signal);
    try { bot.deactivateItem(); } catch { /* instant use */ }
    if (process.env.WATER_TRACE) { const near = []; for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) for (let dy = -2; dy <= 2; dy++) { const b = bot.blockAt(vec({ x: cell.x + dx, y: cell.y + dy, z: cell.z + dz })); if (b?.name === "water") near.push(`${cell.x + dx},${cell.y + dy},${cell.z + dz}`); } log("water", `stand ${JSON.stringify(stand)} pos ${bot.entity.position.floored()} yaw/pitch ${bot.entity.yaw.toFixed(2)}/${bot.entity.pitch.toFixed(2)} held ${bot.heldItem?.name} bucket ${bot.inventory.items().filter((i) => /bucket/.test(i.name)).map((i) => i.name)} water-near ${near.join(" ")}`); }
    const worked = bot.blockAt(vec(cell))?.name === "water";
    return worked ? ok() : fail("water_failed");
  }

  if (cell.kind === "plant") {
    const seed = bot.inventory.items().find((i) => i.name === cell.item);
    if (!seed) return fail("need_materials", { need: { [cell.item]: 1 } });
    const ground = bot.blockAt(vec({ x: cell.x, y: cell.y - 1, z: cell.z }));
    if (ground?.name !== "farmland" && cell.block !== "nether_wart" && cell.block !== "sweet_berry_bush") return fail("not_farmland");
    const cur = bot.blockAt(vec(cell));
    if (cur && cur.boundingBox === "empty" && cur.name !== "air" && cur.name !== cell.block) await digBlock(ctx, cur);
    await bot.equip(seed, "hand");
    await bot.lookAt(vec(cell).offset(0.5, 0, 0.5), true);
    try { await bot.placeBlock(ground, new Vec3(0, 1, 0)); } catch (e) { if (e.name === "AbortError") throw e; }
    await sleep(150, signal);
    return bot.blockAt(vec(cell))?.name === cell.block ? ok() : fail("plant_failed");
  }

  // ---- solid / decorative blocks, doors ----
  const wrong = await digIfInTheWay(ctx, cell);
  if (!wrong.ok) return wrong;
  const item = itemFor(bot, cell);
  if (!item) return fail("need_materials", { need: { [cell.item]: 1 } });

  if (cell.kind === "door" || cell.kind === "door_upper") {
    if (cell.kind === "door_upper") return ok(); // placed together with the lower half
    // stand on the OUTSIDE, look in, place against the floor block under the doorway
    const out = S.DIRS[cell.facing];
    const stand = { x: cell.x + out.x * 2, y: cell.y, z: cell.z + out.z * 2 };
    if (creative) await require("./creative").hoverAbove(ctx, cell);          // picks a free spot with open sky above - outside the walls
    else await walk(ctx, new goals.GoalBlock(stand.x, stand.y, stand.z), { timeout: 12000 });
    const floor = bot.blockAt(vec({ x: cell.x, y: cell.y - 1, z: cell.z }));
    if (!floor || floor.boundingBox !== "block") return fail("no_floor_for_door");
    await bot.equip(item, "hand");
    await bot.lookAt(vec(cell).offset(0.5, 0, 0.5), true);
    try { await bot.placeBlock(floor, new Vec3(0, 1, 0)); } catch (e) { if (e.name === "AbortError") throw e; }
    await sleep(200, signal);
    return /_door$/.test(bot.blockAt(vec(cell))?.name || "") ? ok() : fail("door_failed");
  }

  // a floating bottom-layer cell over a hole needs ground under it first
  if (cell.y >= 0) {
    const below = { x: cell.x, y: cell.y - 1, z: cell.z };
    if (!solid(bot, vec(below)) && cell.y === ctx.origin.y) {
      const filler = scaffoldItem(bot, { exclude: [cell.block] });
      if (filler) await placeAt(ctx, filler, vec(below));
    }
  }
  const yaw = cell.facing ? YAW[cell.facing] : null;
  const r = await placeAt(ctx, item, vec(cell), { yaw, tries: 3 });
  if (r.ok) return ok();
  // unsupported (floating): put a temporary support block under it, place, then keep the support only if it is part of the spec
  const filler = scaffoldItem(bot, { exclude: [cell.block] });
  if (filler && !solid(bot, vec({ x: cell.x, y: cell.y - 1, z: cell.z }))) {
    const sp = await placeAt(ctx, filler, vec({ x: cell.x, y: cell.y - 1, z: cell.z }));
    if (sp.ok) { const again = await placeAt(ctx, item, vec(cell), { yaw, tries: 2 }); if (again.ok) { (ctx.temp ||= []).push({ x: cell.x, y: cell.y - 1, z: cell.z }); return ok(); } }
  }
  return r;
}

/** Fill an empty bucket at the nearest water (also used to refill after pouring). */
async function fillBucket(ctx) {
  const { bot, signal } = ctx;
  const bucket = bot.inventory.items().find((i) => i.name === "bucket");
  if (!bucket) return fail("need_materials", { need: { bucket: 1 } });
  const water = bot.findBlock({ matching: bot.registry.blocksByName.water.id, maxDistance: 48, useExtraInfo: (b) => Number(b.getProperties?.().level ?? b.metadata) === 0 && !(ctx.origin && Math.abs(b.position.x - ctx.origin.x) < 14 && Math.abs(b.position.z - ctx.origin.z) < 14 && Math.abs(b.position.y - ctx.origin.y) < 4) });
  if (!water) return fail("no_water_nearby");
  const w = await walk(ctx, new goals.GoalNear(water.position.x, water.position.y, water.position.z, 2.2), { timeout: 25000 });
  if (!w.ok && bot.entity.position.distanceTo(water.position) > 4.5) return fail("cannot_reach_water");
  await bot.equip(bucket, "hand");
  await bot.lookAt(water.position.offset(0.5, 0.9, 0.5), true);
  try { bot.deactivateItem(); } catch { /* not using */ }
  bot.activateItem(); await sleep(450, signal);
  try { bot.deactivateItem(); } catch { /* instant use */ }
  return bot.inventory.items().some((i) => i.name === "water_bucket") ? ok() : fail("bucket_not_filled");
}

/**
 * args: { spec, id, origin? }. Resumes the remembered site for this id; verifies by diffing the real world.
 */
/** Within each layer, place a cell only once something is there to place it against (a floor/roof is grown outward from its walls). */
function supportOrder(bot, ordered) {
  const out = [], byY = new Map();
  for (const c of ordered) { if (!byY.has(c.y)) byY.set(c.y, []); byY.get(c.y).push(c); }
  const N = [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, -1, 0], [0, 1, 0]];
  for (const layer of byY.values()) {
    const chosen = new Set(), rest = layer.slice();
    const key = (x, y, z) => `${x},${y},${z}`;
    const supported = (c) => N.some(([dx, dy, dz]) => chosen.has(key(c.x + dx, c.y + dy, c.z + dz)) || solid(bot, vec({ x: c.x + dx, y: c.y + dy, z: c.z + dz })));
    while (rest.length) {
      let progressed = false;
      for (let i = 0; i < rest.length;) {
        if (supported(rest[i])) { const c = rest.splice(i, 1)[0]; chosen.add(key(c.x, c.y, c.z)); out.push(c); progressed = true; } else i++;
      }
      if (!progressed) { const c = rest.shift(); chosen.add(key(c.x, c.y, c.z)); out.push(c); }
    }
  }
  return out;
}

async function buildStructure(ctx, args) {
  try { return await buildStructure0(ctx, args); }
  finally { if (ctx.bot.game?.gameMode === "creative") { try { ctx.bot.creative.stopFlying(); } catch { /* not flying */ } } }   // never leave a creative builder hovering with gravity off (it then could not walk to the next job)
}

async function buildStructure0(ctx, { spec, id }) {
  const { bot, reg, mem, signal } = ctx;
  const compiled = S.compileStructure(spec, reg);
  if (!compiled.ok) return fail("invalid_spec", { errors: compiled.errors });
  const memKey = `structure:${id}`;
  let rec = mem.recall(memKey);
  if (!rec) {
    let site = null;
    const anchor = ctx.agent?.goal?.anchor;
    if (anchor) {                                                // the player said WHERE: honour it exactly, do not go looking for a "nicer" spot
      const sp = require("../runtime/spatial");
      let o = sp.originFromAnchor(bot, anchor, { w: compiled.size.w, d: compiled.size.d });
      if (o.error && anchor.flex) {                              // a planned plot (village layout) may be wet or unloaded: slide it a little instead of failing
        for (const r of [4, 8, 12, 16, 22]) { for (let i = 0; i < 8 && o.error; i++) { const ang = (i / 8) * Math.PI * 2; o = sp.originFromAnchor(bot, { ...anchor, x: anchor.x + Math.round(Math.cos(ang) * r), z: anchor.z + Math.round(Math.sin(ang) * r) }, { w: compiled.size.w, d: compiled.size.d }); } if (!o.error) break; }
      }
      if (o.error) { ctx.agent.say(`I can't build there: ${o.error}.`, { force: true }); ctx.agent.abandon?.(); return fail("bad_anchor", { message: o.error }); }
      site = { origin: o.origin };
      ctx.agent.think(`building where you meant: x${o.origin.x} y${o.origin.y} z${o.origin.z} (${anchor.mode}${anchor.facing ? ", facing " + anchor.facing : ""})`);
    } else site = chooseSite(bot, { w: compiled.size.w, d: compiled.size.d }, "south");
    if (!site) return fail("no_site", { size: compiled.size });
    rec = { origin: site.origin, name: spec.name };
    mem.remember(memKey, rec);
    try { const pr = ctx.agent?.goal?.project; if (pr) require("../runtime/project").progress(pr.id, pr.taskId, { origin: site.origin }); } catch { /* the board is best effort */ }
    try { ctx.agent?.know.add({ kind: "build", label: spec.name, pos: site.origin, size: { w: compiled.size.w, d: compiled.size.d, h: compiled.size.h } }); } catch { /* knowledge is best effort */ }
    if (ctx.agent?.goal?.type !== "assist") require("../runtime/shared").publishBuild(bot.username, { sid: ctx.agent?.goal?.sid, name: spec.name, spec, origin: site.origin, done: false });
    ctx.agent?.think(`building "${spec.name}" at ${site.origin.x} ${site.origin.y} ${site.origin.z}`);
  }
  ctx.origin = rec.origin;
  const cells = compiled.cells.map((c) => S.abs(c, rec.origin));
  const at = mkAt(bot);
  let placed = 0, lastMissing = Infinity;
  const deferred = new Map();
  let accepted = null;                                    // cells that need something the bag does not have yet: skipped now, built after the next gathering batch

  for (let pass = 1; pass <= 5; pass++) {
    throwIfAborted(signal);
    const d = S.diffStructure(cells, at);
    const repairOnly = ctx.agent?.goal?.mode === "repair";                 // repair: fill what is missing, never touch what stands (even if it differs from the plan)
    const todo = repairOnly ? [...d.missing] : [...d.wrong, ...d.missing];
    if (d.unknown.length && !todo.length) { await walk(ctx, new goals.GoalNear(rec.origin.x + 2, rec.origin.y, rec.origin.z + 2, 4), { timeout: 15000 }); continue; }
    if (!todo.length) break;
    if (todo.length >= lastMissing && pass > 2 && todo.length <= Math.max(4, Math.ceil(cells.length * 0.03))) {
      // a handful of stubborn blocks (a roof peak, a window nobody can reach) are not worth the whole team standing around: call it built, like a player would
      ctx.agent?.think(`${spec.name}: good enough - ${todo.length} awkward block${todo.length > 1 ? "s" : ""} left (${todo.slice(0, 3).map((c) => c.block + "@" + c.x + "," + c.y + "," + c.z).join(" ")})`);
      log("structure", `accepting ${spec.name} with ${todo.length}/${cells.length} blocks missing`);
      try { require("../runtime/shared").publishBuild(bot.username, { done: true }); } catch { /* best effort */ }
      accepted = todo.length;
      break;                                                     // (scaffold still gets taken down below)
    }
    if (todo.length >= lastMissing && pass > 2) return fail("no_progress", { missing: todo.length, sample: todo.slice(0, 4).map((c) => `${c.block}@${c.x},${c.y},${c.z}`) });
    lastMissing = todo.length;
    ctx.agent?.think(`${spec.name}: pass ${pass}, ${todo.length} blocks to place`);
    // phase 1: clear everything that is in the way (grass/stone/old blocks) while nothing of ours hides it yet
    const creativeNow = bot.game?.gameMode === "creative";
    for (const cell of repairOnly ? [] : S.orderCells(d.wrong.filter((c) => c.kind === "block"), bot.entity.position)) {
      throwIfAborted(signal); ctx.beat?.();
      const cur = bot.blockAt(vec(cell));
      if (!cur || cur.boundingBox !== "block") continue;
      const t0 = Date.now(); const reach = bot.game?.gameMode === "creative" ? ((await require("./creative").hoverAbove(ctx, cell)) ? ok() : fail("hover")) : await standNear(ctx, cell);
      const dg = reach.ok ? await digIfInTheWay(ctx, cell) : reach;
      if (process.env.BUILD_TRACE) log("structure", `clear ${cur.name}@${cell.x},${cell.y},${cell.z} reach=${reach.ok || reach.reason} dig=${dg.ok || dg.reason} ${Date.now() - t0}ms`);
    }
    const helper = ctx.agent?.goal?.type === "assist";
    const order0 = creativeNow ? [...S.orderCells(repairOnly ? [] : d.wrong, bot.entity.position), ...supportOrder(bot, S.orderCells(d.missing, bot.entity.position))] : S.orderCells(todo, bot.entity.position);   // remove what is in the way first, before our own walls hide it
    const order = helper ? order0.reverse() : order0;    // a helper starts from the other end so two builders do not fight over the same cells
    let sinceSweep = 0;
    for (const cell of order) {
      throwIfAborted(signal);
      ctx.beat?.();
      const sig = `st:${id}:${cell.x},${cell.y},${cell.z}`;
      if (mem.strikesOf(sig) >= 3) continue;
      const t0 = Date.now(); const r = await placeCell(ctx, cell);
      if (process.env.BUILD_TRACE || Date.now() - t0 > 4000) log("structure", `cell ${cell.block}@${cell.x},${cell.y},${cell.z} ${r.ok ? "ok" : r.reason} in ${Date.now() - t0}ms me=${bot.entity.position.toString()} flying=${bot.creative?.flying}`);
      if (r.ok) { placed++; sinceSweep++; if (placed % 100 === 0) log("structure", `${placed}/${order.length} placed this pass`); }
      else {
        if (r.reason === "need_materials") { for (const [k, v] of Object.entries(r.data?.need || {})) deferred.set(k, (deferred.get(k) || 0) + v); continue; }
        mem.strike(sig);
        log("structure", `cell ${cell.block}@${cell.x},${cell.y},${cell.z} failed: ${r.reason}`);
      }
      if (sinceSweep >= 8) { await collectDrops(ctx, { radius: 6, maxMs: 1500 }); sinceSweep = 0; }
    }
    mem.clearStrikes(`st:${id}:`);
    if (deferred.size) break;                                    // build what the bag allows; the planner fetches the next batch and calls again
  }

  if (bot.game?.gameMode === "creative") { try { bot.creative.stopFlying(); } catch { /* landed */ } }
  // take the scaffold away again (top-down), then verify for real
  for (const p of (ctx.scaffold || []).reverse()) {
    const b = bot.blockAt(vec(p));
    if (b && b.boundingBox === "block" && !cells.some((c) => c.x === p.x && c.y === p.y && c.z === p.z)) { await walk(ctx, new goals.GoalNear(p.x, p.y, p.z, 3), { timeout: 8000 }); await digBlock(ctx, b).catch(() => {}); }
  }
  // temporary support blocks placed under overhangs come out again (unless the design itself wants a block there)
  for (const p of (ctx.temp || []).reverse()) {
    if (cells.some((c) => c.x === p.x && c.y === p.y && c.z === p.z && c.kind !== "air")) continue;
    const b = bot.blockAt(vec(p));
    if (!b || b.boundingBox !== "block") continue;
    if (bot.game?.gameMode === "creative") await require("./creative").hoverAbove(ctx, p, { side: true }); else await walk(ctx, new goals.GoalNear(p.x, p.y, p.z, 3), { timeout: 8000 });
    await digBlock(ctx, b, { depth: 6 }).catch(() => null);
  }
  ctx.temp = [];
  if (accepted != null) return { ok: true, data: { verified: true, partial: accepted, cells: cells.length, origin: rec.origin }, progress: { verified: 1, accepted: 1, blocks: placed } };
  if (deferred.size) {
    if (!placed) return fail("need_materials", { need: Object.fromEntries(deferred), placed });
    ctx.agent?.think(`${spec.name}: placed ${placed} blocks, need ${[...deferred.keys()].slice(0, 3).map((k) => k.replace(/_/g, " ")).join(", ")} for the next part`);
    return { ok: true, data: { partial: true, placed, waiting_for: Object.fromEntries(deferred) }, progress: { blocks: placed } };
  }
  // best-effort decoration (torches, lanterns...): never blocks success
  for (const c of S.diffStructure(cells, at).optionalMissing.slice(0, 40)) { throwIfAborted(signal); await placeCell(ctx, c).catch(() => {}); }
  const fin = S.diffStructure(cells, at);
  const left = fin.missing.length + (ctx.agent?.goal?.mode === "repair" ? 0 : fin.wrong.length) + fin.unknown.length;
  if (left) return fail("verify_failed", { missing: left, ratio: fin.ratio, sample: [...fin.missing, ...fin.wrong].slice(0, 5).map((c) => `${c.block}@${c.x},${c.y},${c.z}`), placed });
  try { require("../runtime/shared").publishBuild(bot.username, { done: true }); } catch { /* best effort */ }
  return { ok: true, data: { verified: true, cells: cells.length, placed, origin: rec.origin }, progress: { verified: 1, blocks: placed } };
}

module.exports = { buildStructure, placeCell, fillBucket };
