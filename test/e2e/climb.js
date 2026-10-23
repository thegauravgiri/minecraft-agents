// Buried deep in solid rock, target far above: the bot must dig itself out (no path exists).
const mineflayer = require("mineflayer");
const { Vec3 } = require("vec3");
const { connect, consoleCmd, botCmd, sleep, waitUntil, settle } = require("./harness");
(async () => {
  const { bot, agent } = await connect("ClimbBot");
  consoleCmd("difficulty peaceful"); consoleCmd("time set day"); consoleCmd("gamemode survival ClimbBot");
  await botCmd(bot, "effect give @s slow_falling 30 1 true");
  consoleCmd("tp ClimbBot 500 150 500"); await sleep(3000);
  consoleCmd("forceload add 470 470 530 530"); await sleep(500);
  await botCmd(bot, "fill 480 50 480 520 175 520 air");
  await botCmd(bot, "fill 480 50 480 520 150 520 stone");              // solid rock block, 50 high, open sky above y=150
  await botCmd(bot, "fill 500 91 500 500 92 500 air");                 // tiny cell to stand in at y=101
  await waitUntil(() => bot.blockAt(new Vec3(500, 91, 500))?.name === "air" && bot.blockAt(new Vec3(500, 140, 500))?.name === "stone", 10000, 200);
  await botCmd(bot, "clear @s"); await botCmd(bot, "give @s iron_pickaxe");
  consoleCmd("tp ClimbBot 500 91 500"); await sleep(1500); await botCmd(bot, "effect clear @s");
  const s = mineflayer.createBot({ host: "localhost", port: 25599, username: "Steve", auth: "offline", version: "26.1.2" });
  await new Promise((r) => s.once("spawn", r)); consoleCmd("op Steve"); await sleep(600);
  agent.run();
  s.chat("ClimbBot go to 505 152 500");
  const t0 = Date.now();
  const ok = await waitUntil(() => bot.entity.position.y > 148 && bot.entity.position.distanceTo(new Vec3(505, 152, 500)) < 8, 150000, 500);
  console.log(ok ? "PASS climbed out of rock" : "FAIL", "y", bot.entity.position.y.toFixed(1), Math.round((Date.now() - t0) / 1000) + "s");
  agent.stop(); bot.quit(); s.quit(); process.exit(ok ? 0 : 1);
})();
