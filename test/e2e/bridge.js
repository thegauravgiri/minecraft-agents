const mineflayer = require("mineflayer");
const { Vec3 } = require("vec3");
const { connect, consoleCmd, botCmd, sleep, waitUntil, settle } = require("./harness");
(async () => {
  const { bot, agent } = await connect("BridgeBot");
  consoleCmd("difficulty peaceful"); consoleCmd("time set day"); consoleCmd("gamemode survival BridgeBot");
  await botCmd(bot, "effect give @s slow_falling 30 1 true");
  consoleCmd("tp BridgeBot 300 205 300"); await settle(bot);
  consoleCmd("forceload add 280 280 340 320"); await sleep(500);
  await botCmd(bot, "fill 285 190 280 335 215 320 air");
  await botCmd(bot, "fill 290 200 298 296 200 302 stone");   // start platform
  await botCmd(bot, "fill 312 200 298 318 200 302 stone");
  await botCmd(bot, "fill 297 195 296 311 210 304 air");   // clear any bridge left by earlier runs
  await waitUntil(() => bot.blockAt(new Vec3(293, 200, 300))?.name === "stone" && bot.blockAt(new Vec3(315, 200, 300))?.name === "stone", 15000, 300);
  await botCmd(bot, "clear @s"); await botCmd(bot, "give @s cobblestone 40");
  consoleCmd("tp BridgeBot 292 201 300"); await sleep(2000); await botCmd(bot, "effect clear @s");
  const s = mineflayer.createBot({ host: "localhost", port: 25599, username: "Steve", auth: "offline", version: "26.1.2" });
  await new Promise((r) => s.once("spawn", r)); consoleCmd("op Steve"); await sleep(600);
  agent.run();
  s.chat("BridgeBot go to 315 201 300");
  const tgt = new Vec3(315, 201, 300);
  const ok = await waitUntil(() => bot.entity.position.distanceTo(tgt) < 4, 90000, 500);
  const below = (x) => bot.blockAt(new Vec3(x, 200, 300))?.name + "/" + bot.blockAt(new Vec3(x, 201, 300))?.name;
  console.log("under gap x=304:", below(304), "x=308:", below(308), "gamemode", bot.game.gameMode);
  console.log(ok ? "PASS bridged gap" : "FAIL", "pos", bot.entity.position.floored().toString(), "cobble left", bot.inventory.items().filter((i) => i.name === "cobblestone").reduce((a, i) => a + i.count, 0));
  agent.stop(); bot.quit(); s.quit(); process.exit(ok ? 0 : 1);
})();
