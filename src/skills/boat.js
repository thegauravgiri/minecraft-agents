// Water crossing: sprint-swimming and boats (place -> mount -> steer -> dismount -> verify).
// Boats are client-authoritative on the server: the rider sends vehicle_move packets, so we
// integrate the boat's motion ourselves and keep the local entity state in sync.
const { Vec3 } = require("vec3");
const { toNotchianYaw } = require("mineflayer/lib/conversions");
const { goals, goto } = require("./move");
const { craft } = require("./craft");
const { collectDrops } = require("./blocks");
const { sleep, throwIfAborted, waitFor, ok, fail, invCount, log } = require("../runtime/util");

const isBoatName = (n) => !!n && /(_boat|_raft)$/.test(n);
const isBoatEntity = (e) => !!e && isBoatName(e.name);
const boatItem = (bot) => {
  const items = bot.inventory.items().filter((i) => isBoatName(i.name));
  return items.find((i) => !i.name.includes("chest")) || items[0] || null;
};

const hdist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const isWater = (b) => !!b && (b.name === "water" || b.name === "bubble_column" || b.getProperties?.().waterlogged === true);
const isSolid = (b) => !!b && b.boundingBox === "block";

function setControls(bot, c) {
  for (const k of ["forward", "back", "left", "right", "jump", "sprint"]) bot.setControlState(k, !!c[k]);
}

// mineflayer only reacts to set_passengers lists that contain the bot, so a dismount (empty list)
// leaves bot.vehicle stale. Track it ourselves.
const tracked = new WeakSet();
function trackVehicle(bot) {
  if (tracked.has(bot)) return;
  tracked.add(bot);
  bot._client.on("set_passengers", ({ entityId, passengers }) => {
    if (bot.vehicle && bot.vehicle.id === entityId && !passengers.includes(bot.entity.id)) {
      const v = bot.vehicle;
      bot.vehicle = null;
      if (bot.entity) bot.entity.vehicle = null;
      if (v.passengers) v.passengers = v.passengers.filter((p) => p.id !== bot.entity.id);
      bot.emit("dismount", v);
    }
  });
}

// ---- sampling -----------------------------------------------------------------------------

// Classify the column at (x,z): 'water' (deep >=2, or shallow), 'land', 'void'.
function column(bot, x, z, yTop, yBottom = yTop - 12) {
  for (let y = Math.floor(yTop); y >= Math.floor(yBottom); y--) {
    const b = bot.blockAt(new Vec3(Math.floor(x), y, Math.floor(z)));
    if (!b) return { kind: "unknown", y };
    if (isWater(b)) {
      const below = bot.blockAt(new Vec3(Math.floor(x), y - 1, Math.floor(z)));
      const below2 = bot.blockAt(new Vec3(Math.floor(x), y - 2, Math.floor(z)));
      return { kind: "water", y, deep: isWater(below) && isWater(below2) };
    }
    if (isSolid(b)) return { kind: "land", y };
  }
  return { kind: "void", y: yBottom };
}

function waterBetween(bot, a, b) {
  const len = hdist(a, b);
  const n = Math.max(1, Math.ceil(len));
  const yTop = Math.max(a.y, b.y) + 2;
  let waterBlocks = 0, deepWater = 0, total = 0;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const c = column(bot, a.x + (b.x - a.x) * t, a.z + (b.z - a.z) * t, yTop);
    if (c.kind === "unknown") continue;
    total++;
    if (c.kind === "water") { waterBlocks++; if (c.deep) deepWater++; }
  }
  return { waterBlocks, total, deepWater, length: len };
}

function shouldUseWater(bot, targetPos) {
  const s = waterBetween(bot, bot.entity.position, targetPos);
  if (s.deepWater < 3 && s.waterBlocks < 6) return "walk";
  const hasBoat = !!boatItem(bot);
  if (hasBoat && s.waterBlocks >= 10 && s.deepWater >= 6) return "boat";
  return "swim";
}

// ---- swimming -----------------------------------------------------------------------------

const yawTo = (from, to) => Math.atan2(-(to.x - from.x), -(to.z - from.z));
const feetInWater = (bot) => isWater(bot.blockAt(bot.entity.position));
const headInWater = (bot) => isWater(bot.blockAt(bot.entity.position.offset(0, 1.62, 0)));

async function swimAcross(ctx, { pos, timeout = 60000 } = {}) {
  const { bot, signal } = ctx;
  if (!pos) return fail("no_target");
  const target = new Vec3(pos.x, pos.y ?? bot.entity.position.y, pos.z);
  const t0 = Date.now();
  const hp0 = bot.health;
  let minO2 = bot.oxygenLevel ?? 20, sdbg = 0;
  let anchor = bot.entity.position.clone(), anchorT = t0, usedPath = false;
  try {
    for (;;) {
      throwIfAborted(signal);
      ctx.beat?.();
      await sleep(50, signal);
      const me = bot.entity.position;
      const d = hdist(me, target);
      const wet = feetInWater(bot);
      minO2 = Math.min(minO2, bot.oxygenLevel ?? 20);
      if (process.env.BOAT_DEBUG && ++sdbg % 20 === 0) log("swim", me.toString(), "d", d.toFixed(1), "wet", wet, "o2", bot.oxygenLevel, "usedPath", usedPath);
      const arrived = d < 1.6 && Math.abs(me.y - target.y) < 3 && (bot.entity.onGround || wet);
      if (arrived) return ok({ d: +d.toFixed(1), minOxygen: minO2, hpLost: Math.max(0, hp0 - bot.health), ms: Date.now() - t0 });
      if (Date.now() - t0 > timeout) return fail("timeout", { d: +d.toFixed(1) });
      if (bot.health <= 4 && bot.health < hp0) return fail("unsafe_health", { hp: bot.health });

      const low = (bot.oxygenLevel ?? 20) <= 8;
      const yaw = yawTo(me, target);
      const dy = target.y - me.y;
      const climb = wet && (dy > 0.5 || low || headInWater(bot));
      await bot.look(yaw, wet ? (low ? 0.5 : 0) : 0, true);
      // keep the head above the surface when short of air: stop forward only if critically low and deep
      const critical = (bot.oxygenLevel ?? 20) <= 3 && headInWater(bot);
      setControls(bot, { forward: !critical, sprint: !critical, jump: climb || bot.entity.isCollidedHorizontally });

      if (Date.now() - anchorT > 2500) {
        if (hdist(me, anchor) < 0.5 && me.distanceTo(anchor) < 0.8) {
          if (usedPath) return fail("stuck", { d: +d.toFixed(1) });
          usedPath = true;
          setControls(bot, {});
          const g = await goto(ctx, new goals.GoalNear(target.x, target.y, target.z, 1.5), { timeout: 12000, towardPos: target });
          if (!g.ok && g.reason !== "timeout") return fail("stuck", { d: +d.toFixed(1), why: g.reason });
        }
        anchor = bot.entity.position.clone(); anchorT = Date.now();
      } else if (hdist(me, anchor) > 0.8) { anchor = me.clone(); anchorT = Date.now(); }
    }
  } finally {
    setControls(bot, {});
  }
}

// ---- boats --------------------------------------------------------------------------------

function nearbyBoats(bot, r = 8) {
  return Object.values(bot.entities).filter((e) => isBoatEntity(e) && e.position && e.position.distanceTo(bot.entity.position) <= r && !(e.passengers?.length))
    .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position));
}

async function craftBoat(ctx) {
  const { bot } = ctx;
  const planks = bot.inventory.items().filter((i) => i.name.endsWith("_planks")).sort((a, b) => b.count - a.count);
  const best = planks[0];
  if (!best || best.count < 5) return fail("no_boat", { need: { oak_planks: 5 } });
  const wood = best.name.replace("_planks", "");
  const name = wood === "bamboo" ? "bamboo_raft" : `${wood}_boat`;
  const item = bot.registry.itemsByName[name] ? name : "oak_boat";
  if (!invCount(bot, "crafting_table") && !bot.findBlock({ matching: bot.registry.blocksByName.crafting_table.id, maxDistance: 6 })) {
    if (best.count < 9) return fail("no_boat", { need: { [best.name]: 9 }, why: "needs_crafting_table" });
    const t = await craft(ctx, { item: "crafting_table", count: 1, times: 1 });
    if (!t.ok) return fail("no_boat", { need: { oak_planks: 9 }, why: t.reason });
  }
  const r = await craft(ctx, { item, count: 1, times: 1, table: true });
  if (!r.ok) return fail("craft_boat_failed", { why: r.reason });
  return ok({ item });
}

function surfaceWaterNear(bot, toward, maxR = 4) {
  const eye = bot.entity.position.offset(0, 1.62, 0);
  const base = bot.entity.position.floored();
  let best = null, bs = Infinity;
  for (let dx = -maxR; dx <= maxR; dx++) for (let dz = -maxR; dz <= maxR; dz++) for (let dy = -3; dy <= 1; dy++) {
    const p = base.offset(dx, dy, dz);
    const b = bot.blockAt(p), up = bot.blockAt(p.offset(0, 1, 0));
    if (!isWater(b) || !up || isWater(up) || isSolid(up)) continue;
    const c = p.offset(0.5, 0.9, 0.5);
    const de = eye.distanceTo(c);
    if (de > 4.6 || de < 1.2) continue;
    const below = bot.blockAt(p.offset(0, -1, 0));
    if (!isWater(below)) continue;
    let roomy = true;
    for (const [ox, oz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
      const n = bot.blockAt(p.offset(ox, 0, oz));
      if (!isWater(n)) { roomy = false; break; }
    }
    if (!roomy) continue;
    const score = de + (toward ? hdist(c, toward) * 0.05 : 0);
    if (score < bs) { bs = score; best = p; }
  }
  return best;
}

async function placeBoat(ctx, item, dest) {
  const { bot, signal } = ctx;
  let spot = surfaceWaterNear(bot, dest);
  if (!spot) {
    const ids = [bot.registry.blocksByName.water.id];
    const w = bot.findBlocks({ matching: ids, maxDistance: 32, count: 400 })
      .filter((p) => {
        const up = bot.blockAt(p.offset(0, 1, 0));
        return up && !isWater(up) && !isSolid(up) && isWater(bot.blockAt(p.offset(0, -1, 0)));
      })
      .sort((p, q) => p.distanceTo(bot.entity.position) - q.distanceTo(bot.entity.position))
      .map((p) => ({ position: p }))[0];
    if (!w) return fail("no_water_nearby");
    const g = await goto(ctx, new goals.GoalNear(w.position.x, w.position.y, w.position.z, 3), { timeout: 25000, towardPos: w.position });
    if (!g.ok) return fail("cannot_reach_water", { why: g.reason });
    spot = surfaceWaterNear(bot, dest);
    if (!spot) return fail("no_water_nearby");
  }
  await bot.equip(item, "hand");
  await sleep(250, signal);
  const before = new Set(Object.keys(bot.entities));
  const aim = spot.offset(0.5, 0.9, 0.5);
  await bot.lookAt(aim, true);
  await sleep(120, signal);
  bot.activateItem();
  const ent = await waitFor(() => Object.values(bot.entities).find((e) => !before.has(String(e.id)) && isBoatEntity(e)), { timeout: 2500, interval: 50, signal });
  if (!ent) return fail("boat_not_placed");
  return ok({ entity: ent });
}

async function mountBoat(ctx, boat) {
  const { bot, signal } = ctx;
  for (let i = 0; i < 4; i++) {
    throwIfAborted(signal);
    if (bot.vehicle) return ok();
    const live = bot.entities[boat.id];
    if (!live) return fail("boat_gone");
    if (live.position.distanceTo(bot.entity.position) > 3) {
      await goto(ctx, new goals.GoalNear(live.position.x, live.position.y, live.position.z, 2), { timeout: 8000, towardPos: live.position, dig: false });
    }
    await bot.lookAt(live.position.offset(0, 0.4, 0), true);
    bot.mount(live);
    if (await waitFor(() => bot.vehicle, { timeout: 1200, interval: 50, signal })) return ok();
  }
  return fail("mount_failed");
}

function sendDrive(bot, x, y, z, yawRad) {
  bot._client.write("player_input", { inputs: { forward: true, backward: false, left: false, right: false, jump: false, shift: false, sprint: false } });
  bot._client.write("vehicle_move", { x, y, z, yaw: toNotchianYaw(yawRad), pitch: 0, onGround: false });
}

function boatCellOk(bot, x, y, z) {
  const here = bot.blockAt(new Vec3(Math.floor(x), Math.floor(y + 0.3), Math.floor(z)));
  const under = bot.blockAt(new Vec3(Math.floor(x), Math.floor(y - 0.3), Math.floor(z)));
  const head = bot.blockAt(new Vec3(Math.floor(x), Math.floor(y + 1.2), Math.floor(z)));
  if (!here || !under || isSolid(here) || isSolid(under) || isSolid(head)) return false;
  return isWater(here) || isWater(under);
}

function clearAhead(bot, p, yaw, len) {
  const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
  const sx = -fz, sz = fx;
  for (let s = 0.7; s <= len; s += 0.5) {
    for (const o of [-0.7, 0, 0.7]) {
      if (!boatCellOk(bot, p.x + fx * s + sx * o, p.y, p.z + fz * s + sz * o)) return false;
    }
  }
  return true;
}

async function dismount(ctx) {
  const { bot, signal } = ctx;
  trackVehicle(bot);
  if (!bot.vehicle) return ok({ already: true });
  for (let i = 0; i < 4 && bot.vehicle; i++) {
    bot._client.write("player_input", { inputs: { forward: false, backward: false, left: false, right: false, jump: false, shift: true, sprint: false } });
    await sleep(120, signal).catch(() => {});
    bot._client.write("player_input", { inputs: { forward: false, backward: false, left: false, right: false, jump: false, shift: false, sprint: false } });
    if (await waitFor(() => !bot.vehicle, { timeout: 500, interval: 40 })) break;
  }
  return bot.vehicle ? fail("dismount_failed") : ok();
}

// Dropped boats can sink to the lake floor: dive for them, surface when air runs low.
async function fetchSunkenBoat(ctx, maxMs = 12000) {
  const { bot, signal } = ctx;
  const t0 = Date.now();
  const find = () => Object.values(bot.entities)
    .filter((e) => (e.name === "item" || e.name === "item_stack") && e.position.distanceTo(bot.entity.position) < 9 && (() => { try { return isBoatName(e.getDroppedItem?.()?.name); } catch { return false; } })())
    .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0];
  try {
    while (Date.now() - t0 < maxMs && !boatItem(bot)) {
      throwIfAborted(signal);
      const it = find();
      if (!it) return false;
      const me = bot.entity.position;
      const air = bot.oxygenLevel ?? 20;
      const wet = feetInWater(bot);
      const below = it.position.y < me.y - 1;
      await bot.look(yawTo(me, it.position), 0, true);
      const dive = wet && below && air > 9;
      setControls(bot, { forward: hdist(me, it.position) > 0.4, sprint: false, jump: wet && !dive });
      await sleep(50, signal);
      if (!wet && hdist(me, it.position) < 1) break;
    }
  } finally { setControls(bot, {}); }
  return !!boatItem(bot);
}

async function recoverBoat(ctx, boat) {
  const { bot, signal } = ctx;
  const id = boat.id;
  const reach = () => bot.entities[id] && bot.entities[id].position.distanceTo(bot.entity.position.offset(0, 1, 0)) <= 3;
  if (bot.entities[id] && !reach()) {
    const e = bot.entities[id];
    await goto(ctx, new goals.GoalNear(e.position.x, e.position.y, e.position.z, 2.5), { timeout: 6000, dig: false, towardPos: e.position });
  }
  for (let i = 0; i < 24 && bot.entities[id] && reach() && !feetInWater(bot); i++) {
    await bot.lookAt(bot.entities[id].position.offset(0, 0.4, 0), true);
    bot.attack(bot.entities[id]);
    await sleep(270, signal);
  }
  if (!bot.entities[id]) {
    await collectDrops(ctx, { radius: 6, maxMs: 2500 });
    if (!boatItem(bot)) await fetchSunkenBoat(ctx);
  }
  return !!boatItem(bot);
}

// Short dry-land approach by hand: never steps into water, so it cannot wander off into the lake.
async function landWalk(ctx, target, range, maxMs = 6000) {
  const { bot, signal } = ctx;
  const t0 = Date.now();
  try {
    while (Date.now() - t0 < maxMs) {
      throwIfAborted(signal);
      const me = bot.entity.position;
      if (hdist(me, target) <= range) return true;
      const yaw = yawTo(me, target);
      const ax = me.x - Math.sin(yaw) * 0.9, az = me.z - Math.cos(yaw) * 0.9;
      const col = column(bot, ax, az, me.y + 1, me.y - 2);
      if (col.kind === "water" || col.kind === "void") return false;
      await bot.look(yaw, 0, true);
      setControls(bot, { forward: true, sprint: true, jump: !!bot.entity.isCollidedHorizontally });
      await sleep(50, signal);
    }
    return false;
  } finally { setControls(bot, {}); }
}

async function drive(ctx, boat, destFn, { arrive, maxMs }) {
  const { bot, signal } = ctx;
  const t0 = Date.now();
  let speed = 0.05;
  let p = bot.vehicle.position.clone();
  let yaw = bot.vehicle.yaw ?? 0;
  let result = null, blockedTicks = 0, lastSend = 0, dbg = 0;
  const startDist = hdist(p, destFn());
  while (!result) {
    throwIfAborted(signal);
    ctx.beat?.();
    await sleep(50, signal);
    if (!bot.vehicle || bot.health <= 0) return { why: "ejected", p, startDist };
    if (process.env.BOAT_DEBUG && ++dbg % 10 === 0) log("boat", "drive", p.toString(), "yaw", yaw.toFixed(2), "sp", speed.toFixed(2), "d", hdist(p, destFn()).toFixed(1), "me", bot.entity.position.toString(), "veh", bot.vehicle.position.toString());
    if (Date.now() - t0 > maxMs) return { why: "timeout", p, startDist };
    const dest = destFn();
    if (!dest) return { why: "target_lost", p, startDist };
    const dx = dest.x - p.x, dz = dest.z - p.z;
    const d = Math.hypot(dx, dz);
    if (d <= arrive) return { why: "arrived", p, startDist };
    const want = Math.atan2(-dx, -dz);
    let chosen = null;
    for (const off of [0, 0.3, -0.3, 0.6, -0.6, 1.0, -1.0, 1.5, -1.5]) {
      const a = want + off;
      if (clearAhead(bot, p, a, Math.min(3.5, Math.max(1.2, d)))) { chosen = a; break; }
    }
    if (chosen == null) {
      if (++blockedTicks > 3) return { why: "blocked", p, startDist };
      speed = 0.05;
    } else {
      blockedTicks = 0;
      let dy = chosen - yaw;
      dy = Math.atan2(Math.sin(dy), Math.cos(dy));
      yaw += Math.max(-0.5, Math.min(0.5, dy));
      const cap = Math.min(0.32, 0.08 + d * 0.04);
      const turnPenalty = Math.abs(dy) > 0.6 ? 0.5 : 1;
      speed = Math.min(cap * turnPenalty, speed + 0.03);
      if (speed > cap * turnPenalty) speed = cap * turnPenalty;
      const nx = p.x - Math.sin(yaw) * speed, nz = p.z - Math.cos(yaw) * speed;
      if (boatCellOk(bot, nx, p.y, nz)) p = new Vec3(nx, p.y, nz);
      else { speed = 0.05; blockedTicks++; }
    }
    sendDrive(bot, p.x, p.y, p.z, yaw);
    const v = bot.vehicle;
    if (v) { v.position.set(p.x, p.y, p.z); v.yaw = yaw; }
    bot.entity.position.set(p.x, p.y + 0.35, p.z);
    bot.entity.velocity.set(0, 0, 0);
    bot.entity.yaw = yaw;
    lastSend++;
  }
}

async function boatTo(ctx, { pos, entityId, maxMs = 90000, keepBoat = true } = {}) {
  const { bot, signal } = ctx;
  const live = () => (entityId != null ? bot.entities[entityId]?.position : null) || pos;
  let dest = live();
  if (!dest) return fail("no_target");
  const goalDist = (entityId != null ? 3 : 2.2);
  const t0 = Date.now();
  let boat = null, placed = false;
  trackVehicle(bot);
  try {
    if (hdist(bot.entity.position, dest) <= goalDist + 1) return ok({ already: true });
    if (bot.vehicle && isBoatEntity(bot.vehicle)) boat = bot.vehicle;
    if (!boat) {
      boat = nearbyBoats(bot, 6).find((b) => isWater(bot.blockAt(b.position.offset(0, 0.2, 0))) || isWater(bot.blockAt(b.position))) || null;
      let item = boatItem(bot);
      if (!boat && !item) {
        const c = await craftBoat(ctx);
        if (!c.ok) return c;
        item = boatItem(bot);
        if (!item) return fail("no_boat", { need: { oak_planks: 5 } });
      }
      if (!boat) {
        let r = await placeBoat(ctx, item, dest);
        for (let i = 0; i < 2 && !r.ok && r.reason === "boat_not_placed"; i++) { await sleep(300, signal); r = await placeBoat(ctx, boatItem(bot) || item, dest); }
        if (!r.ok) return r;
        boat = r.data.entity;
        placed = true;
        log("boat", "placed", boat.name, boat.id);
      }
      const m = await mountBoat(ctx, boat);
      if (!m.ok) { if (placed) await recoverBoat(ctx, boat); return m; }
      if (!bot.vehicle) return fail("mount_failed");
      log("boat", "mounted");
    }

    const res = await drive(ctx, boat, () => live(), { arrive: goalDist, maxMs: Math.max(5000, maxMs - (Date.now() - t0)) });
    const remainingBefore = hdist(res.p, live() || res.p);
    const d = await dismount(ctx);
    if (!d.ok) return fail("dismount_failed");
    await sleep(250, signal);
    if (bot.vehicle) return fail("dismount_failed");
    if (feetInWater(bot) && live()) await swimAcross(ctx, { pos: live(), timeout: 20000 });
    if (keepBoat && placed && bot.entities[boat.id] && !feetInWater(bot)) await recoverBoat(ctx, boat);
    if (feetInWater(bot) && live()) await swimAcross(ctx, { pos: live(), timeout: 20000 });
    let end = live();
    if (end && hdist(bot.entity.position, end) > goalDist + 1 && !feetInWater(bot)) {
      const near = await landWalk(ctx, end, goalDist);
      end = live();
      if (!near && end && hdist(bot.entity.position, end) > goalDist + 6) {
        await Promise.race([
          goto(ctx, new goals.GoalNear(end.x, end.y ?? bot.entity.position.y, end.z, goalDist), { timeout: 12000, towardPos: end, dig: false }),
          sleep(15000, signal),
        ]);
        try { bot.pathfinder.stop(); } catch { /* idle */ }
        if (feetInWater(bot) && live()) await swimAcross(ctx, { pos: live(), timeout: 15000 });
        end = live();
      }
    }
    const remaining = end ? hdist(bot.entity.position, end) : remainingBefore;
    const data = { why: res.why, remaining: +remaining.toFixed(1), ms: Date.now() - t0, boat: boat.name, recovered: !!boatItem(bot) };
    if (res.why === "arrived" || remaining <= goalDist + 4) return ok(data);
    if (res.why === "blocked" && remaining < res.startDist * 0.5) return ok(data);
    return fail("boat_" + res.why, data);
  } finally {
    setControls(bot, {});
    if (bot.vehicle) { try { await dismount({ bot, signal: undefined }); } catch { /* best effort */ } }
  }
}

module.exports = { swimAcross, boatTo, shouldUseWater, waterBetween, dismount, craftBoat, isBoatName, boatItem };
