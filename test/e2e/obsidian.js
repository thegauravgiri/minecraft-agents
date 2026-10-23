const mineflayer = require("mineflayer");
const { connect, consoleCmd, botCmd, sleep, waitUntil, settle } = require("./harness");
(async () => {
  const { bot, agent } = await connect("ObsBot");
  const s = mineflayer.createBot({ host: "localhost", port: 25599, username: "Steve", auth: "offline", version: "26.1.2" });
  await new Promise((r) => s.once("spawn", r));
  consoleCmd("op Steve"); consoleCmd("difficulty peaceful"); consoleCmd("time set day"); consoleCmd("gamemode survival ObsBot");
  consoleCmd("tp ObsBot 150 90 -150"); await settle(bot);
  const f = bot.entity.position.floored();
  await botCmd(bot, "clear @s"); await botCmd(bot, "give @s diamond_pickaxe");
  await botCmd(bot, "effect give @s hunger 60 30 true");   // food will drop while digging: eating must not restart the dig
  consoleCmd(`fill ${f.x + 3} ${f.y} ${f.z - 1} ${f.x + 4} ${f.y + 1} ${f.z} obsidian`);
  await sleep(1200);
  agent.run();
  let digStarts = 0, digDone = 0;
  const orig = bot.dig.bind(bot);
  bot.dig = (...a) => { digStarts++; return orig(...a).then((r) => { digDone++; return r; }); };
  s.chat("ObsBot get 4 obsidian");
  const n = () => bot.inventory.items().filter((i) => i.name === "obsidian").reduce((a, i) => a + i.count, 0);
  const ok = await waitUntil(() => n() >= 4, 120000, 500);
  console.log(ok ? "PASS" : "FAIL", "obsidian", n(), "dig() calls", digStarts, "completed", digDone, "food", bot.food);
  agent.stop(); bot.quit(); s.quit(); process.exit(ok ? 0 : 1);
})();
