// Riding anything: happy ghasts (harness, driver seat, client-authoritative flight), boats, minecarts, saddled horses & co.
// Mounting is always the same two steps - get next to it, interact - plus whatever the mount needs first (a ghast needs its harness).
// DRIVING a happy ghast works like a boat: the first passenger is the controller and the server trusts the rider's `vehicle_move` packets,
// so we fly it ourselves (cruise over terrain, descend onto the target, never with shift held - shift dismounts).
const { Vec3 } = require("vec3");
const { goals, goto } = require("./move");
const { sleep, throwIfAborted, waitFor, ok, fail, log } = require("../runtime/util");

const RIDEABLE = /(^|_)(boat|raft)$|^minecart$|^(horse|donkey|mule|skeleton_horse|zombie_horse|camel|pig|strider|happy_ghast|llama|trader_llama)$/;
const isRideable = (e) => !!e && !!e.name && RIDEABLE.test(e.name);
const toNotchianYaw = (yawRad) => { const d = (180 - (yawRad * 180) / Math.PI) % 360; return d < 0 ? d + 360 : d; };

/** Which entity does the player mean? name/type words, "nearest", or "the one <player> is on". */
function findRideable(bot, { target = null, withPlayer = null } = {}) {
  const me = bot.entity.position;
  if (withPlayer) {
    const key = Object.keys(bot.players).find((k) => k.toLowerCase() === String(withPlayer).toLowerCase());
    const v = key && bot.players[key]?.entity?.vehicle;
    if (v) return v;
  }
  const want = String(target || "").toLowerCase().replace(/\s+/g, "_");
  const list = Object.values(bot.entities).filter((e) => e !== bot.entity && isRideable(e) && e.position.distanceTo(me) < 64);
  const matches = want && want !== "nearest" && want !== "any" ? list.filter((e) => e.name.includes(want) || want.includes(e.name) || (want === "ghast" && e.name === "happy_ghast") || (want === "boat" && /boat|raft/.test(e.name))) : list;
  return (matches.length ? matches : list).sort((a, b) => a.position.distanceTo(me) - b.position.distanceTo(me))[0] || null;
}

const bodySlot = (e) => (e.equipment || [])[6] || null;               // a happy ghast's harness sits in the body slot

async function wearHarness(ctx, ghast) {
  const { bot, signal } = ctx;
  if (bodySlot(ghast)) return ok("already");
  let h = bot.inventory.items().find((i) => /_harness$/.test(i.name));
  if (!h && bot.game?.gameMode === "creative") { await require("./creative").giveItems(ctx, { items: { white_harness: 1 } }); h = bot.inventory.items().find((i) => /_harness$/.test(i.name)); }
  if (!h) return fail("need_harness", { need: { white_harness: 1 } });
  await bot.equip(h, "hand");
  await bot.lookAt(ghast.position.offset(0, ghast.height / 2, 0), true);
  await bot.activateEntity(ghast);
  const done = await waitFor(() => bodySlot(bot.entities[ghast.id] || ghast), { timeout: 3000, interval: 100, signal });
  return done ? ok() : fail("harness_not_accepted");
}

/** Get on. `target`/`withPlayer` pick the mount; a ghast without harness gets one first. */
async function mount(ctx, args = {}) {
  const { bot, signal } = ctx;
  if (bot.vehicle && (!args.target || bot.vehicle.name.includes(String(args.target).replace(/\s+/g, "_")))) return ok({ already: true, vehicle: bot.vehicle.name });
  if (bot.vehicle) await dismount(ctx);
  const e = findRideable(bot, args);
  if (!e) return fail("nothing_to_ride", { message: "no rideable entity within 64 blocks" });
  if (e.name === "happy_ghast") {
    await approach(ctx, e, 4);
    const w = await wearHarness(ctx, bot.entities[e.id] || e); if (!w.ok) return w;
  }
  for (let i = 0; i < 4; i++) {
    throwIfAborted(signal);
    const live = bot.entities[e.id]; if (!live) return fail("mount_gone");
    await approach(ctx, live, e.name === "happy_ghast" ? 3.5 : 2.2);
    await bot.lookAt(live.position.offset(0, Math.min(live.height / 2, 1.2), 0), true);
    if (bot.heldItem) { try { await bot.unequip("hand"); } catch { /* hands already free-ish */ } }
    try { await bot.activateEntity(live); } catch { /* interact is best effort, we verify below */ }
    if (await waitFor(() => bot.vehicle, { timeout: 1500, interval: 50, signal })) return ok({ vehicle: bot.vehicle.name, seat: (bot.vehicle.passengers || []).indexOf(bot.entity) });
    if (!bot.vehicle && bot.mount) { try { bot.mount(live); } catch { /* try again */ } if (await waitFor(() => bot.vehicle, { timeout: 1200, interval: 50, signal })) return ok({ vehicle: bot.vehicle.name }); }
  }
  return fail("mount_failed");
}

async function approach(ctx, e, range) {
  const { bot } = ctx;
  if (bot.entity.position.distanceTo(e.position) <= range + (e.height || 1) / 2) return;
  const flyable = bot.game?.gameMode === "creative" && e.position.y - bot.entity.position.y > 3;
  if (flyable) { await require("./creative").flyTo(ctx, e.position.x, e.position.y, e.position.z, { direct: false }); return; }
  await goto(ctx, new goals.GoalNear(e.position.x, e.position.y, e.position.z, range), { timeout: 20000, towardPos: e.position, dig: false });
}

/** Get off - safely: from the air first descend to the ground (a drop from a ghast's height kills). */
async function dismount(ctx, { land = true } = {}) {
  const { bot, signal } = ctx;
  if (!bot.vehicle) return ok({ already: true });
  const v = bot.vehicle;
  if (v.name === "happy_ghast" && land && controller(bot, v)) await landGhast(ctx, v);
  // sneak is the dismount key: hold it a moment through the normal control state (that is what a client does), then the explicit APIs
  for (let i = 0; i < 4 && bot.vehicle; i++) {
    throwIfAborted(signal);
    bot.setControlState("sneak", true);
    await waitFor(() => !bot.vehicle, { timeout: 900, interval: 50, signal });
    bot.setControlState("sneak", false);
    if (!bot.vehicle) break;
    try { bot.dismount(); } catch { /* old API */ }
    await waitFor(() => !bot.vehicle, { timeout: 700, interval: 50, signal });
    if (bot.vehicle) { try { bot._client.write("player_input", { inputs: { shift: true } }); } catch { /* gone */ } await waitFor(() => !bot.vehicle, { timeout: 900, interval: 50, signal }); try { bot._client.write("player_input", { inputs: { shift: false } }); } catch { /* gone */ } }
  }
  if (bot.vehicle) return fail("dismount_failed");
  // the server puts us on the ghast's back (it is 4 blocks tall and solid): walk off its edge. mineflayer does not know entities can be stood on and would
  // "fall" through it (the server then pulls us back every tick), so gravity is paused while we cross the top, then we drop the last blocks normally.
  if (v.name === "happy_ghast") {
    await sleep(400, signal);
    const g = groundBelow(bot, bot.entity.position, 12);
    const live = bot.entities[v.id] || v;
    if (g != null && bot.entity.position.y - g > 2.2) {
      const c = live.position, p = bot.entity.position;
      let yaw = Math.atan2(-(p.x - c.x), -(p.z - c.z));
      if (Math.hypot(p.x - c.x, p.z - c.z) < 0.5) yaw = bot.entity.yaw;                      // dead centre: just keep our heading
      const grav = bot.physics.gravity;
      try {
        bot.physics.gravity = 0; bot.entity.velocity.y = 0;
        await bot.look(yaw, 0, true);
        bot.setControlState("forward", true);
        const t0 = Date.now();
        while (Date.now() - t0 < 2800 && Math.hypot(bot.entity.position.x - c.x, bot.entity.position.z - c.z) < 3.2) { bot.entity.velocity.y = 0; await sleep(50, signal); }
      } finally { bot.setControlState("forward", false); bot.physics.gravity = grav; }
      await sleep(600, signal);
    }
  }
  return ok({ left: v.name });
}

const controller = (bot, v) => (v.passengers || [])[0] === bot.entity || (v.passengers || []).length === 0;

// ---------------------------------------------------------------- driving a happy ghast
const solid = (bot, x, y, z) => { const b = bot.blockAt(new Vec3(Math.floor(x), Math.floor(y), Math.floor(z))); return !!b && b.boundingBox === "block"; };
/** Is the 4x4x4 box of the ghast (bottom-centre at p) free of blocks? */
function boxFree(bot, p) {
  for (let dx = -2; dx <= 1; dx += 1) for (let dz = -2; dz <= 1; dz += 1) for (let dy = 0; dy < 4; dy += 1) if (solid(bot, p.x + dx + 0.5, p.y + dy, p.z + dz + 0.5)) return false;
  return true;
}
function groundBelow(bot, p, max = 80) { for (let y = Math.floor(p.y) - 1; y > Math.floor(p.y) - max; y--) if (solid(bot, p.x, y, p.z)) return y + 1; return null; }

function send(bot, cur, yawRad, pitchRad) {
  bot._client.write("player_input", { inputs: { forward: true, backward: false, left: false, right: false, jump: false, shift: false, sprint: false } });
  bot._client.write("vehicle_move", { x: cur.x, y: cur.y, z: cur.z, yaw: toNotchianYaw(yawRad), pitch: Math.max(-90, Math.min(90, (pitchRad * 180) / Math.PI)) });
}

/**
 * Fly the ghast I am driving to a point (or to a player, following them), cruising above anything in the way.
 * args: { pos:{x,y,z} | player, hover: blocks above the target to stop at, land: descend and dismount, maxMs }
 */
async function drive(ctx, args = {}) {
  const { bot, signal } = ctx;
  let v = bot.vehicle;
  if (!v) { const m = await mount(ctx, { target: "happy_ghast" }); if (!m.ok) return m; v = bot.vehicle; }
  if (v.name !== "happy_ghast") return fail("cannot_drive:" + v.name, { message: "I can only steer a happy ghast (boats have their own skill)" });
  if (!controller(bot, v)) return fail("not_the_driver", { message: "somebody else sits in the driver seat" });
  const speed = 0.36;                                                     // blocks per 50 ms tick (~7 b/s): well inside what the server accepts
  const t0 = Date.now(), maxMs = args.maxMs || 150000;
  let cur = v.position.clone();
  let stuck = 0, fixedY = null;
  const targetOf = () => {
    if (args.player) { const key = Object.keys(bot.players).find((k) => k.toLowerCase() === String(args.player).toLowerCase()); const e = key && bot.players[key]?.entity; if (e) return e.position.clone(); const w = ctx.agent?.radar?.where(args.player); return w?.pos ? new Vec3(w.pos.x, w.pos.y, w.pos.z) : null; }
    if (!args.pos) return null;
    if (fixedY == null) fixedY = args.pos.y ?? (groundBelow(bot, new Vec3(args.pos.x, cur.y + 60, args.pos.z), 160) ?? cur.y);      // decided ONCE: the ground at the target (a moving target height made it climb forever)
    return new Vec3(args.pos.x, fixedY, args.pos.z);
  };
  try {
    for (;;) {
      throwIfAborted(signal); ctx.beat?.();
      if (!bot.vehicle) return fail("fell_off");
      if (Date.now() - t0 > maxMs) return fail("drive_timeout");
      const t = targetOf();
      if (!t) { await sleep(300, signal); if (Date.now() - t0 > 20000) return fail("target_unknown"); continue; }
      // re-sync if the server moved us (rejected step / bump)
      const real = bot.vehicle.position;
      if (real.distanceTo(cur) > 1.6) cur = real.clone();
      const dh = Math.hypot(t.x - cur.x, t.z - cur.z);
      const hoverY = t.y + (args.hover ?? 2);
      if (dh < 3 && Math.abs(hoverY - cur.y) < 2.5 && !args.follow) break;
      // cruise altitude: clear the terrain between here and the target (sampled), plus the ghast's own height
      let top = hoverY;
      for (let s = 0; s <= dh; s += 3) { const f = dh ? s / dh : 0; const g = groundBelow(bot, new Vec3(cur.x + (t.x - cur.x) * f, cur.y + 60, cur.z + (t.z - cur.z) * f), 140); if (g != null) top = Math.max(top, g + 1); }
      const cruise = dh > 12 ? top + 3 : hoverY;
      let dx = 0, dy = 0, dz = 0;
      if (dh >= 3 && cur.y < cruise - 1) dy = 1;                                                  // climb first
      else if (dh >= 3) { dx = (t.x - cur.x) / dh; dz = (t.z - cur.z) / dh; dy = Math.abs(cruise - cur.y) > 1.5 ? Math.sign(cruise - cur.y) * 0.4 : 0; }
      else dy = Math.sign(hoverY - cur.y);
      const len = Math.hypot(dx, dy, dz) || 1;
      let next = cur.offset((dx / len) * speed, (dy / len) * speed, (dz / len) * speed);
      if (!boxFree(bot, next)) {
        // something in the way: go up, else slide sideways
        const options = [cur.offset(0, speed, 0), cur.offset(dz * speed, 0, -dx * speed), cur.offset(-dz * speed, 0, dx * speed)];
        next = options.find((o) => boxFree(bot, o)) || null;
        if (!next) { if (++stuck > 40) return fail("blocked"); await sleep(50, signal); continue; }
      }
      stuck = 0;
      if (process.env.RIDE_TRACE && (Date.now() - t0) % 7 < 2) log("ride", `cur ${cur.x.toFixed(1)} ${cur.y.toFixed(1)} ${cur.z.toFixed(1)} -> next ${next.x.toFixed(1)} ${next.y.toFixed(1)} ${next.z.toFixed(1)} target ${t.x.toFixed(0)},${t.y.toFixed(0)},${t.z.toFixed(0)} cruise ${cruise.toFixed(1)} real ${bot.vehicle.position.x.toFixed(1)} ${bot.vehicle.position.y.toFixed(1)} ${bot.vehicle.position.z.toFixed(1)}`);
      cur = next;
      const yaw = Math.atan2(-(t.x - cur.x), -(t.z - cur.z));
      send(bot, cur, yaw, Math.atan2(-(t.y - cur.y), Math.max(dh, 1)));
      await sleep(50, signal);
    }
  } finally {
    try { bot._client.write("player_input", { inputs: { forward: false, backward: false, left: false, right: false, jump: false, shift: false, sprint: false } }); } catch { /* connection gone */ }
  }
  if (args.land) { await landGhast(ctx, bot.vehicle); const d = await dismount(ctx, { land: false }); return d.ok ? { ok: true, data: { landed: true }, progress: { arrived: 1 } } : d; }
  return { ok: true, data: { arrived: true, at: { x: Math.round(cur.x), y: Math.round(cur.y), z: Math.round(cur.z) } }, progress: { arrived: 1 } };
}

/** Straight down to the ground (the ghast stands on it), so nobody falls when they get off. */
async function landGhast(ctx, v) {
  const { bot, signal } = ctx;
  let cur = (bot.vehicle || v).position.clone();
  for (let i = 0; i < 400 && bot.vehicle; i++) {
    throwIfAborted(signal);
    const g = groundBelow(bot, cur, 140);
    if (g == null || cur.y - g < 0.4) break;
    const next = cur.offset(0, -Math.min(0.3, cur.y - g), 0);
    if (!boxFree(bot, next)) break;
    cur = next; send(bot, cur, bot.entity.yaw, 0);
    await sleep(50, signal);
  }
  try { bot._client.write("player_input", { inputs: { forward: false, backward: false, left: false, right: false, jump: false, shift: false, sprint: false } }); } catch { /* gone */ }
  await sleep(300, signal);
}

module.exports = { isRideable, findRideable, mount, dismount, drive, landGhast, wearHarness };
