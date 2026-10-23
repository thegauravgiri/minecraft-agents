const mineflayer = require("mineflayer");
const { connect, consoleCmd, botCmd, sleep, waitUntil, settle } = require("./harness");
const only = process.argv[2];
(async () => {
  const { bot, agent } = await connect("XBot");
  const s = mineflayer.createBot({ host: "localhost", port: 25599, username: "Steve", auth: "offline", version: "26.1.2" });
  await new Promise((r) => s.once("spawn", r));
  consoleCmd("op Steve"); consoleCmd("difficulty peaceful"); consoleCmd("time set day"); consoleCmd("gamemode survival Steve"); consoleCmd("gamemode survival XBot");
  await sleep(500);
  consoleCmd("tp XBot 150 90 -150"); await settle(bot); consoleCmd("tp Steve XBot"); await sleep(1500);
  agent.run();
  const inv = (n) => bot.inventory.items().filter((i) => i.name === n).reduce((a, i) => a + i.count, 0);
  const sinv = (n) => s.inventory.items().filter((i) => i.name === n).reduce((a, i) => a + i.count, 0);
  const say = (m) => s.chat("XBot " + m);
  const results = [];
  const check = async (name, fn) => { if (only && only !== name) return; const t = Date.now(); let ok = false; try { ok = await fn(); } catch (e) { console.log(name, "threw", e.message); } results.push([name, ok]); console.log(ok ? "PASS" : "FAIL", name, Math.round((Date.now() - t) / 1000) + "s"); };

  await check("sleep_at_night", async () => {
    consoleCmd("tp XBot 150 90 -150"); await settle(bot);
    const f = bot.entity.position.floored();
    consoleCmd(`fill ${f.x - 4} ${f.y} ${f.z - 4} ${f.x + 8} ${f.y + 3} ${f.z + 4} air`); await sleep(300);
    consoleCmd(`setblock ${f.x + 3} ${f.y} ${f.z} white_bed[part=foot,facing=east]`); consoleCmd(`setblock ${f.x + 4} ${f.y} ${f.z} white_bed[part=head,facing=east]`);
    consoleCmd("time set 13500"); await sleep(600);
    let slept = false; bot.on("sleep", () => { slept = true; });
    say("sleep");
    await waitUntil(() => agent.goal || slept, 8000, 100);
    const done = await waitUntil(() => slept, 30000, 200);
    consoleCmd("time set day");
    return done;
  });
  await check("place_chest", async () => {
    await botCmd(bot, "clear @s"); await botCmd(bot, "give @s oak_planks 16");
    say("place a chest");
    return waitUntil(() => !agent.goal && bot.findBlock({ matching: bot.registry.blocksByName.chest.id, maxDistance: 8 }), 60000, 500);
  });
  await check("shelter", async () => {
    { const f = bot.entity.position.floored(); consoleCmd(`fill ${f.x - 2} ${f.y} ${f.z - 2} ${f.x + 2} ${f.y + 3} ${f.z + 2} air`); await sleep(400); }
    await botCmd(bot, "clear @s"); await botCmd(bot, "give @s dirt 24");
    say("shelter");
    await waitUntil(() => agent.goal, 8000, 100);
    const ok = await waitUntil(() => !agent.goal, 40000, 300);
    const f = bot.entity.position.floored();
    const walls = [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [1, 1, 0], [-1, 1, 0], [0, 1, 1], [0, 1, -1], [0, 2, 0]].every((d) => bot.blockAt(f.offset(...d))?.boundingBox === "block");
    return ok && walls;
  });
  await check("cook_deliver", async () => {
    consoleCmd("tp XBot 150 90 -150"); await settle(bot);
    await botCmd(bot, "clear @s"); await botCmd(bot, "give @s beef 3"); await botCmd(bot, "give @s coal 2"); await botCmd(bot, "give @s furnace");
    consoleCmd("clear Steve"); consoleCmd("tp Steve XBot"); await sleep(1500);
    say("cook 3 meat for me");
    return waitUntil(() => sinv("cooked_beef") >= 3, 150000, 1000);
  });
  await check("recover", async () => {
    consoleCmd("tp XBot 150 90 -150"); await settle(bot);
    await botCmd(bot, "clear @s"); await botCmd(bot, "give @s diamond_pickaxe"); await botCmd(bot, "give @s iron_sword");
    say("get 6 oak logs"); await sleep(4000);   // active goal at the moment of death
    const spots = bot.entity.position.floored();
    consoleCmd("kill XBot");
    const back = await waitUntil(() => inv("diamond_pickaxe") >= 1 && inv("iron_sword") >= 1, 120000, 1000);
    return back;
  });
  console.log(JSON.stringify(results));
  agent.stop(); bot.quit(); s.quit(); process.exit(results.every((r) => r[1]) ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(2); });
