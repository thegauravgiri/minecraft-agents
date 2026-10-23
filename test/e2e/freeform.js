const mineflayer = require("mineflayer");
const { connect, consoleCmd, botCmd, sleep, waitUntil, settle } = require("./harness");
const task = process.argv[2] || "dig a hole 4 blocks deep right here and then climb back out";
(async () => {
  const { bot, agent } = await connect("FreeBot");
  const s = mineflayer.createBot({ host: "localhost", port: 25599, username: "Steve", auth: "offline", version: "26.1.2" });
  await new Promise((r) => s.once("spawn", r));
  consoleCmd("op Steve"); consoleCmd("difficulty peaceful"); consoleCmd("time set day");
  consoleCmd("gamemode survival FreeBot"); await botCmd(bot, "clear @s"); await botCmd(bot, "give @s iron_pickaxe"); await botCmd(bot, "give @s cobblestone 32");
  consoleCmd("tp FreeBot 150 90 -150"); await settle(bot);
  agent.run();
  const heard = []; s.on("chat", (u, m) => { if (u === "FreeBot") heard.push(m); });
  s.chat("FreeBot " + task);
  const y0 = bot.entity.position.y;
  let minY = y0;
  const t0 = Date.now();
  while (Date.now() - t0 < 120000) { minY = Math.min(minY, bot.entity.position.y); if (!agent.director.ctl && Date.now() - t0 > 8000) break; await sleep(500); }
  console.log("heard:", JSON.stringify(heard));
  console.log("y0", y0.toFixed(1), "minY", minY.toFixed(1), "final", bot.entity.position.y.toFixed(1), "elapsed", Math.round((Date.now() - t0) / 1000) + "s");
  agent.stop(); bot.quit(); s.quit(); process.exit(0);
})();
