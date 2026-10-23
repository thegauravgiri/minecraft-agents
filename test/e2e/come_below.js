const mineflayer = require("mineflayer");
const { connect, consoleCmd, botCmd, sleep, waitUntil, settle } = require("./harness");
(async () => {
  const { bot, agent } = await connect("DigBot");
  const s = mineflayer.createBot({ host: "localhost", port: 25599, username: "Steve", auth: "offline", version: "26.1.2" });
  await new Promise((r) => s.once("spawn", r));
  consoleCmd("op Steve"); consoleCmd("difficulty peaceful"); consoleCmd("time set day"); consoleCmd("gamemode survival Steve"); consoleCmd("gamemode survival DigBot");
  await botCmd(bot, "clear @s"); await sleep(300);
  // go near trees at the original spawn, build a stone slab area to stand on, bury Steve 14 blocks below
  consoleCmd("tp DigBot -30 90 56"); await settle(bot);
  const b = bot.entity.position.floored();
  consoleCmd(`fill ${b.x - 3} ${b.y - 1} ${b.z - 3} ${b.x + 3} ${b.y - 1} ${b.z + 3} stone`);
  consoleCmd(`fill ${b.x - 3} ${b.y - 16} ${b.z - 3} ${b.x + 3} ${b.y - 2} ${b.z + 3} stone`);
  consoleCmd(`fill ${b.x} ${b.y - 14} ${b.z} ${b.x + 1} ${b.y - 12} ${b.z + 1} air`);
  consoleCmd(`tp Steve ${b.x} ${b.y - 14} ${b.z}`);
  await sleep(1500);
  agent.run();
  const heard = []; s.on("chat", (u, m) => { if (u === "DigBot") heard.push(m); });
  s.chat("DigBot come to me");
  const dist = () => bot.entity.position.distanceTo(s.entity.position);
  const ok = await waitUntil(() => s.entity && dist() < 5, 280000, 1000);
  console.log(ok ? "PASS reached Steve" : "FAIL", "dist", s.entity && dist().toFixed(1), "y", bot.entity.position.y.toFixed(1), "inv", bot.inventory.items().map((i) => i.name + "x" + i.count).join(","));
  console.log("narration:", JSON.stringify(heard.slice(0, 12)));
  agent.stop(); bot.quit(); s.quit(); process.exit(ok ? 0 : 1);
})();
