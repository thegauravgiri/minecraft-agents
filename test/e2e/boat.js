const mineflayer = require("mineflayer");
const { connect, consoleCmd, botCmd, sleep, waitUntil, settle } = require("./harness");
const { swimAcross, boatTo, shouldUseWater, waterBetween } = require("../../src/skills/boat");
const { Memory } = require("../../src/core/memory");

const NAME = "BoatBot";
const results = [];
const check = (name, cond, extra) => { results.push(!!cond); console.log((cond ? "PASS " : "FAIL ") + name, extra !== undefined ? JSON.stringify(extra) : ""); };

(async () => {
  const { bot, agent, reg } = await connect(NAME);
  const ctl = new AbortController();
  const ctx = { bot, reg, mem: new Memory(), signal: ctl.signal, agent };
  consoleCmd("difficulty peaceful");
  await botCmd(bot, "gamemode survival");
  await botCmd(bot, "effect give @s slow_falling 60 1 true");
  consoleCmd(`tp ${NAME} -400 110 -400`); await settle(bot);
  consoleCmd("kill @e[type=#minecraft:boat,x=-400,y=64,z=-400,distance=..60]");
  consoleCmd("forceload add -430 -420 -360 -385");
  await sleep(500);
  // basin: solid block to y63, lake carved and flooded, air above
  await botCmd(bot, "fill -425 50 -411 -365 63 -390 stone");
  await botCmd(bot, "fill -425 64 -411 -365 90 -390 air");
  await botCmd(bot, "fill -410 56 -406 -381 63 -395 water");
  const Vec = require("vec3").Vec3;
  const lakeReady = await waitUntil(() => bot.blockAt(new Vec(-400, 62, -400))?.name === "water" && bot.blockAt(new Vec(-400, 64, -400))?.name === "air", 15000, 300);
  if (!lakeReady) { console.log("FAIL fixture: lake not built"); process.exit(2); }
  const west = () => { consoleCmd(`tp ${NAME} -416 64 -400`); };
  const reset = async () => {
    await botCmd(bot, "clear @s"); await botCmd(bot, "effect clear @s");
    consoleCmd("kill @e[type=item,x=-400,y=64,z=-400,distance=..40]");
    consoleCmd("kill @e[type=#minecraft:boat,x=-400,y=64,z=-400,distance=..40]");
    await sleep(400);
    west(); await sleep(1500);
    await waitUntil(() => bot.entity.position.x < -410 && bot.entity.onGround && !bot.vehicle, 8000, 200);
    await botCmd(bot, "effect give @s saturation 10 10 true");
    await botCmd(bot, "effect give @s instant_health 1 5 true");
  };
  await sleep(1000);

  // ---- helpers
  const far = { x: -376.5, y: 64, z: -400.5 };
  const stats = waterBetween(bot, new (require("vec3").Vec3)(-416, 64, -400), new (require("vec3").Vec3)(far.x, 64, far.z));
  check("waterBetween sees lake", stats.waterBlocks >= 25 && stats.deepWater >= 25, stats);

  // 1. swim
  await reset();
  let minO2 = 20, running = true;
  const mon = setInterval(() => { if (bot.oxygenLevel != null) minO2 = Math.min(minO2, bot.oxygenLevel); }, 50);
  check("decision walk->swim (no boat)", shouldUseWater(bot, new (require("vec3").Vec3)(far.x, 64, far.z)) === "swim");
  const hp0 = bot.health;
  let r = await swimAcross(ctx, { pos: far, timeout: 40000 });
  console.log("swim", JSON.stringify(r), "pos", bot.entity.position.toString());
  check("swimAcross arrives", r.ok && Math.hypot(bot.entity.position.x - far.x, bot.entity.position.z - far.z) < 3);
  check("swim health unharmed", bot.health >= hp0 - 0.1, bot.health);
  check("swim oxygen >= 6", minO2 >= 6, minO2);
  clearInterval(mon);

  // 2. boat with item
  await reset();
  await botCmd(bot, "give @s oak_boat"); await waitUntil(() => bot.inventory.items().some((i) => i.name === "oak_boat"), 8000, 100);
  check("decision boat with item", shouldUseWater(bot, new (require("vec3").Vec3)(far.x, 64, far.z)) === "boat");
  r = await boatTo(ctx, { pos: far, maxMs: 60000 });
  console.log("boat", JSON.stringify(r), "pos", bot.entity.position.toString());
  check("boatTo ok", r.ok, r);
  check("boatTo near target", Math.hypot(bot.entity.position.x - far.x, bot.entity.position.z - far.z) < 5);
  check("boatTo dismounted", bot.vehicle == null);
  check("boatTo boat recovered", bot.inventory.items().some((i) => /_boat$/.test(i.name)));
  check("boatTo bot on land", bot.entity.onGround && bot.entity.position.x > -381);

  // 3. no boat no planks
  await reset();
  r = await boatTo(ctx, { pos: far, maxMs: 20000 });
  check("no boat -> fail no_boat", !r.ok && r.reason === "no_boat", r);

  // 4. planks -> craft -> cross
  await reset();
  await botCmd(bot, "give @s oak_planks 10"); await waitUntil(() => bot.inventory.items().some((i) => i.name === "oak_planks"), 8000, 100);
  r = await boatTo(ctx, { pos: far, maxMs: 60000 });
  console.log("craft+boat", JSON.stringify(r), "pos", bot.entity.position.toString());
  check("planks: crafted and crossed", r.ok && bot.vehicle == null && bot.entity.position.x > -382, r);

  // 5. moving target
  await reset();
  await botCmd(bot, "give @s oak_boat"); await waitUntil(() => bot.inventory.items().some((i) => i.name === "oak_boat"), 8000, 100);
  const tgt = mineflayer.createBot({ host: "localhost", port: 25599, username: "BoatTarget", auth: "offline", version: "26.1.2" });
  await new Promise((res) => tgt.once("spawn", res));
  consoleCmd("op BoatTarget"); await sleep(800);
  consoleCmd("tp BoatTarget -377 64 -397"); await sleep(1500);
  const tid = bot.players.BoatTarget?.entity?.id;
  check("target visible", tid != null, tid);
  const moves = [[-377, -403], [-376, -399], [-378, -396]];
  let mi = 0;
  const mover = setInterval(() => { const m = moves[mi++ % moves.length]; consoleCmd(`tp BoatTarget ${m[0]} 64 ${m[1]}`); }, 3500);
  r = await boatTo(ctx, { entityId: tid, maxMs: 70000 });
  clearInterval(mover);
  console.log("follow", JSON.stringify(r));
  const te = bot.players.BoatTarget?.entity;
  const dd = te ? Math.hypot(te.position.x - bot.entity.position.x, te.position.z - bot.entity.position.z) : 99;
  check("follow reached target", r.ok && dd < 7 && bot.vehicle == null, { dd });
  tgt.quit();

  const pass = results.every(Boolean);
  console.log(pass ? "PASS boat" : "FAIL boat");
  bot.quit(); process.exit(pass ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(2); });
