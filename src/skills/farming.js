// Farm upkeep: harvest ripe crops and replant them.
const { Vec3 } = require("vec3");
const { goals, goto } = require("./move");
const { digBlock, collectDrops } = require("./blocks");
const { sleep, throwIfAborted, ok, fail, invCount, log } = require("../runtime/util");

const RIPE_AGE = { wheat: 7, carrots: 7, potatoes: 7, beetroots: 3, nether_wart: 3, torchflower: 1 };
const SEED = { wheat: "wheat_seeds", carrots: "carrot", potatoes: "potato", beetroots: "beetroot_seeds", nether_wart: "nether_wart" };
const FRUIT = new Set(["melon", "pumpkin"]);   // grown blocks: just break them (the stem keeps producing)

function ripeCrops(bot, radius = 24) {
  const ids = [...Object.keys(RIPE_AGE), ...FRUIT].map((n) => bot.registry.blocksByName[n]?.id).filter((x) => x != null);
  return bot.findBlocks({ matching: ids, maxDistance: radius, count: 200 }).map((p) => bot.blockAt(p)).filter((b) => {
    if (!b) return false;
    if (FRUIT.has(b.name)) return true;
    const age = Number(b.getProperties?.().age ?? b.metadata);
    return age >= RIPE_AGE[b.name];
  }).sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position));
}

async function harvest(ctx, { radius = 24 } = {}) {
  const { bot, signal } = ctx;
  let cut = 0, replanted = 0;
  for (let guard = 0; guard < 300; guard++) {
    throwIfAborted(signal);
    ctx.beat?.();
    const crop = ripeCrops(bot, radius)[0];
    if (!crop) break;
    const eyeD = bot.entity.position.offset(0, 1.62, 0).distanceTo(crop.position.offset(0.5, 0.5, 0.5));
    if (eyeD > 4.2) {
      const w = await goto(ctx, new goals.GoalNear(crop.position.x, crop.position.y, crop.position.z, 2.5), { timeout: 20000, towardPos: crop.position });
      if (!w.ok) { ctx.mem.banCell(crop.position, 60000); continue; }
    }
    const name = crop.name, pos = crop.position.clone();
    const d = await digBlock(ctx, crop);
    if (!d.ok) { ctx.mem.banCell(pos, 60000); continue; }
    cut++;
    if (SEED[name]) {
      await sleep(120, signal);
      await collectDrops(ctx, { radius: 4, maxMs: 1200 });
      const seed = bot.inventory.items().find((i) => i.name === SEED[name]);
      const ground = bot.blockAt(pos.offset(0, -1, 0));
      if (seed && ground?.name === "farmland") {
        try { await bot.equip(seed, "hand"); await bot.lookAt(pos.offset(0.5, 0, 0.5), true); await bot.placeBlock(ground, new Vec3(0, 1, 0)); replanted++; }
        catch (e) { if (e.name === "AbortError") throw e; }
      }
    }
  }
  await collectDrops(ctx, { radius: 12, maxMs: 4000 });
  return { ok: true, data: { harvested: cut, replanted }, progress: { harvestRuns: 1 } };
}

module.exports = { harvest, ripeCrops };
