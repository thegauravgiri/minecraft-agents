// Set the respawn point: use a nearby bed or place one from the inventory, then verify the spawn actually moved.
const { Vec3 } = require("vec3");
const { goals, goto } = require("./move");
const { placeAt, solid } = require("./blocks");
const { sleep, throwIfAborted, waitFor, ok, fail, log } = require("../runtime/util");

const isBedName = (n) => /_bed$/.test(n || "");
const bedIds = (bot) => Object.values(bot.registry.blocksByName).filter((b) => isBedName(b.name)).map((b) => b.id);

function findFlatPair(bot) {
  const base = bot.entity.position.floored();
  const dirs = [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)];
  for (let r = 1; r <= 4; r++) for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) {
    if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
    for (const dy of [0, 1, -1]) {
      const foot = base.offset(dx, dy, dz);
      for (const d of dirs) {
        const head = foot.plus(d);
        const f = bot.blockAt(foot), h = bot.blockAt(head);
        const fa = bot.blockAt(foot.offset(0, 1, 0)), ha = bot.blockAt(head.offset(0, 1, 0));
        if (f?.boundingBox === "empty" && h?.boundingBox === "empty" && fa?.boundingBox === "empty" && ha?.boundingBox === "empty" && !/water|lava/.test(f.name + h.name)
          && solid(bot, foot.offset(0, -1, 0)) && solid(bot, head.offset(0, -1, 0))) return { foot, head, dir: d };
      }
    }
  }
  return null;
}

// Authoritative check: the player's saved respawn position (needs op; null if unavailable).
function queryRespawn(bot, timeout = 1500) {
  return new Promise((resolve) => {
    const t = setTimeout(() => { bot.removeListener("messagestr", on); resolve(null); }, timeout);
    const on = (m) => {
      const r = String(m).match(new RegExp(`^${bot.username} has the following entity data: \\{pos: \\[I; (-?\\d+), (-?\\d+), (-?\\d+)\\]`));
      if (r) { clearTimeout(t); bot.removeListener("messagestr", on); resolve(new Vec3(+r[1], +r[2], +r[3])); }
    };
    bot.on("messagestr", on);
    bot.chat(`/data get entity ${bot.username} respawn`);
  });
}

// Right-click the bed and read the server's verdict (mineflayer's clock is unreliable on 26.x):
//   state: 'sleeping' | 'day' | 'monsters' | 'occupied' | 'far' | 'unknown'
async function activateBed(ctx, bedBlock, { keepSleeping = false } = {}) {
  const { bot, signal } = ctx;
  let msg = false, state = "unknown";
  const onMsg = (m) => {
    const t = String(m);
    if (/respawn point set|spawn point set|set your spawn/i.test(t)) msg = true;
    if (/sleep only at night|can only sleep at night|only (?:at night|during thunder)/i.test(t)) state = "day";
    else if (/monsters nearby|may not rest now/i.test(t)) state = "monsters";
    else if (/bed is occupied|already occupied/i.test(t)) state = "occupied";
    else if (/too far away/i.test(t)) state = "far";
  };
  bot.on("messagestr", onMsg);
  try {
    await goto(ctx, new goals.GoalNear(bedBlock.position.x, bedBlock.position.y, bedBlock.position.z, 2.5), { timeout: 20000, towardPos: bedBlock.position });
    await bot.lookAt(bedBlock.position.offset(0.5, 0.5, 0.5), true);
    try { await bot.activateBlock(bedBlock); } catch (e) { if (e.name === "AbortError") throw e; }
    await waitFor(() => bot.isSleeping || state !== "unknown", { timeout: 1800, interval: 100, signal });
    if (bot.isSleeping) state = "sleeping";
    if (bot.isSleeping && !keepSleeping) { try { await bot.wake(); } catch { /* already awake */ } }
    if (msg || state === "sleeping") return { set: true, state };
    // no message: either it was already this bed's spawn, or the click failed - ask the server
    const rp = await queryRespawn(bot);
    return { set: !!rp && rp.distanceTo(bedBlock.position) < 4, state };
  } finally { bot.removeListener("messagestr", onMsg); }
}

async function setSpawn(ctx, { sleep: wantSleep = false } = {}) {
  const { bot } = ctx;
  const nearby = bot.findBlock({ matching: bedIds(bot), maxDistance: 32 });
  let bed = nearby;
  if (!bed) {
    const item = bot.inventory.items().find((i) => isBedName(i.name));
    if (!item) return fail("no_bed", { need: { white_bed: 1 } });
    const spot = findFlatPair(bot);
    if (!spot) return fail("no_space_for_bed");
    // the head lands in the direction the bot faces when placing: face along `dir`
    await bot.lookAt(spot.foot.offset(0.5 + spot.dir.x * 2, 0.5, 0.5 + spot.dir.z * 2), true);
    const placed = await placeAt(ctx, item, spot.foot);
    if (!placed.ok) return placed;
    bed = bot.findBlock({ matching: bedIds(bot), maxDistance: 8 });
    if (!bed) return fail("bed_not_found_after_place");
  }
  let attempt = await activateBed(ctx, bed, { keepSleeping: wantSleep });
  // monsters nearby block sleeping: clear them out (like a player would), then try again
  for (let round = 0; wantSleep && attempt.state === "monsters" && round < 3; round++) {
    ctx.agent?.think("monsters nearby are stopping me from sleeping - clearing them first");
    const { fight } = require("./combat");
    const t0 = Date.now();
    while (Date.now() - t0 < 45000) {
      throwIfAborted(ctx.signal);
      const mob = Object.values(bot.entities).filter((e) => e.position && require("../runtime/observe").entityKind(e) === "hostile" && e.position.distanceTo(bot.entity.position) < 28)
        .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0];
      if (!mob) break;
      await fight(ctx, { id: mob.id }, { timeoutMs: 15000 });
    }
    attempt = await activateBed(ctx, bed, { keepSleeping: true });
  }
  if (!attempt.set && attempt.state !== "sleeping" && attempt.state !== "day") return fail("spawn_not_set:" + attempt.state);
  ctx.mem.remember("bed", { x: bed.position.x, y: bed.position.y, z: bed.position.z });
  let slept = false;
  if (wantSleep) {
    if (attempt.state === "sleeping" || bot.isSleeping) {
      slept = true;
      ctx.agent?.say("Sleeping now, goodnight!", { force: true });
      ctx.agent?.think("sleeping until morning");
      // the server wakes us at dawn (or when everyone is asleep); give it up to ~4 min
      try { await waitFor(() => !bot.isSleeping, { timeout: 240000, interval: 500, signal: ctx.signal }); }
      finally { if (bot.isSleeping) { try { await bot.wake(); } catch { /* awake */ } } }
    } else if (attempt.state === "day") {
      ctx.agent?.say("The server says I can only sleep at night - my respawn point is set at this bed.", { force: true });
    } else if (attempt.state === "monsters") {
      ctx.agent?.say("There are still monsters near the bed, so I can't sleep. Respawn point is set.", { force: true });
    } else if (attempt.state === "occupied") {
      ctx.agent?.say("That bed is occupied.", { force: true });
    }
  }
  return { ok: true, data: { bed: bed.position, slept, state: attempt.state }, progress: { spawnSet: 1 } };
}

module.exports = { setSpawn, bedIds, isBedName };
