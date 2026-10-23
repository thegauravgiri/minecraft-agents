// Following a player, and hunting animals/mobs for drops.
const { goals, goto } = require("./move");
const { fight } = require("./combat");
const { explore } = require("./gather");
const { collectDrops } = require("./blocks");
const { sleep, throwIfAborted, ok, fail, invCount, log } = require("../runtime/util");

function playerEntity(bot, name) {
  if (!name) return null;
  const n = name.toLowerCase();
  const key = Object.keys(bot.players).find((k) => k.toLowerCase() === n);
  const e = key ? bot.players[key]?.entity : null;
  return e && bot.entities[e.id] ? e : null;
}

/**
 * Stay close to a player. With stopAt it returns once within that distance ("come");
 * otherwise it runs until aborted ("follow").
 */
async function follow(ctx, { player, stopAt = null }) {
  const { bot, signal } = ctx;
  let lostSince = 0;
  for (;;) {
    throwIfAborted(signal);
    ctx.beat?.();
    const e = playerEntity(bot, player);
    if (!e) {
      if (!lostSince) lostSince = Date.now();
      if (ctx.agent?.chaseOffscreen) {
        const r = await ctx.agent.chaseOffscreen(ctx, player);
        if (r === "arrived") { lostSince = 0; continue; }
      }
      if (Date.now() - lostSince > 8000 && !ctx.agent?.toldBlind) {
        if (ctx.agent) ctx.agent.toldBlind = true;
        ctx.agent?.say(ctx.agent?.radar?.denied ? `I can't see you and I can't locate you without operator rights. Could you come closer, or /op ${bot.username} or /tp ${bot.username} ${player}?` : `I can't see you. Could you come closer, or /tp me to you?`, { force: true });
      }
      if (Date.now() - lostSince > 20000) return fail("player_not_visible");
      await sleep(400, signal); continue;
    }
    lostSince = 0;
    const d = bot.entity.position.distanceTo(e.position);
    if (stopAt != null && d <= stopAt) return ok({ distance: d });
    if (d > 14) {
      const boat = require("./boat");
      if (boat.shouldUseWater(bot, e.position) !== "walk") {
        const w = boat.shouldUseWater(bot, e.position) === "boat" ? await boat.boatTo(ctx, { entityId: e.id, maxMs: 45000 }) : await boat.swimAcross(ctx, { pos: e.position, timeout: 45000 });
        if (w.ok) continue;
      }
    }
    const range = stopAt != null ? Math.max(1.5, stopAt - 0.8) : 2.6;
    const res = await goto(ctx, new goals.GoalFollow(e, range), { dynamic: true, timeout: stopAt != null ? 25000 : 8000, dig: true, noProgressMs: 3000, towardPos: e.position });
    if (!res.ok && res.reason === "no_path") await sleep(600, signal);
  }
}

async function hunt(ctx, { item, mobs, count }) {
  const { bot, signal } = ctx;
  const start = invCount(bot, item);
  const target = start + Math.ceil(count);
  let fruitless = 0;
  while (invCount(bot, item) < target) {
    throwIfAborted(signal);
    ctx.beat?.();
    const mob = Object.values(bot.entities).filter((e) => e.position && mobs.includes(e.name) && e.position.distanceTo(bot.entity.position) < 56)
      .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0];
    if (!mob) {
      if (++fruitless > 5) return fail("not_found", { mobs });
      // somebody saw these animals somewhere: go there before wandering (sightings are shared by the whole team)
      const G = require("./gather");
      const site = mobs.map((m) => G.knownSites(ctx, [], "animal:" + m)[0]).filter(Boolean).sort((a, b) => Math.hypot(a.pos.x - bot.entity.position.x, a.pos.z - bot.entity.position.z) - Math.hypot(b.pos.x - bot.entity.position.x, b.pos.z - bot.entity.position.z))[0];
      if (site) {
        log("explore", `going to where ${mobs[0]} were seen: ${site.pos.x},${site.pos.z}`);
        const w = await goto(ctx, new goals.GoalNearXZ(site.pos.x, site.pos.z, 10), { timeout: 60000, dig: false });
        if (!w.ok) ctx.mem.banCell(new (require("vec3").Vec3)(site.pos.x, site.pos.y ?? bot.entity.position.y, site.pos.z), 300000);
        continue;
      }
      await explore(ctx, { why: "looking for " + mobs[0], distance: 40 + fruitless * 25 });
      continue;
    }
    const r = await fight(ctx, { id: mob.id }, { timeoutMs: 25000 });
    await sleep(250, signal);
    await collectDrops(ctx, { radius: 9, maxMs: 4000 });
    if (!r.ok && r.reason === "timeout") fruitless++;
    else fruitless = 0;
  }
  return ok({ gained: invCount(bot, item) - start });
}

module.exports = { follow, hunt, playerEntity };
