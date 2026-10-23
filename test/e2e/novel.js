// A task no typed goal covers: the director must decompose it, write scripts, repair failures and finish.
const mineflayer = require("mineflayer");
const { connect, consoleCmd, botCmd, sleep, waitUntil, settle } = require("./harness");
const { Vec3 } = require("vec3");
const task = process.argv[2] || "build a 3x3 cobblestone platform two blocks above the ground right next to you and stand on it";
(async () => {
  const { bot, agent } = await connect("NovelBot");
  const s = mineflayer.createBot({ host: "localhost", port: 25599, username: "Steve", auth: "offline", version: "26.1.2" });
  await new Promise((r) => s.once("spawn", r));
  consoleCmd("op Steve"); consoleCmd("difficulty peaceful"); consoleCmd("time set day"); consoleCmd("gamemode survival NovelBot");
  await botCmd(bot, "clear @s"); await botCmd(bot, "give @s cobblestone 40");
  consoleCmd("tp NovelBot 150 90 -150"); await settle(bot);
  agent.run();
  const heard = []; s.on("chat", (u, m) => { if (u === "NovelBot") heard.push(m); });
  s.chat("NovelBot " + task);
  const t0 = Date.now();
  while (Date.now() - t0 < 180000) { await sleep(1000); if (!agent.director.ctl && Date.now() - t0 > 10000 && !agent.goal) break; }
  const f = bot.entity.position.floored();
  let cobbles = 0;
  for (let dx = -5; dx <= 5; dx++) for (let dz = -5; dz <= 5; dz++) for (let dy = -4; dy <= 1; dy++) if (bot.blockAt(f.offset(dx, dy, dz))?.name === "cobblestone") cobbles++;
  console.log("cobblestone blocks placed near bot:", cobbles, "bot pos", f.toString(), "elapsed", Math.round((Date.now() - t0) / 1000) + "s");
  console.log("FAINT+SAID:\n  " + heard.join("\n  "));
  agent.stop(); bot.quit(); s.quit(); process.exit(0);
})();
