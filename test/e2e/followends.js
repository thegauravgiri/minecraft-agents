// "follow me" is a standing order only until the player gives new work: after "go to x y z" the bot stays there instead of trailing the player again.
process.env.MC_AUTONOMY = "off"; process.env.MC_BANTER = "off";
const mineflayer = require("mineflayer");
const { connect, consoleCmd, sleep, waitUntil, settle } = require("./harness");
(async () => {
  const { bot, agent } = await connect("Tagger");
  const s = mineflayer.createBot({ host: "localhost", port: 25599, username: "Steve", auth: "offline", version: "26.1.2" });
  await new Promise((r) => s.once("spawn", r)); consoleCmd("op Steve"); consoleCmd("difficulty peaceful"); consoleCmd("time set day");
  const X = 1300, Z = 900, Y = 150;
  consoleCmd(`forceload add ${X - 30} ${Z - 30} ${X + 30} ${Z + 30}`); await sleep(2000);
  for (let x = X - 30; x <= X + 30; x += 15) { consoleCmd(`fill ${x} ${Y - 3} ${Z - 30} ${x + 14} ${Y - 1} ${Z + 30} grass_block`); consoleCmd(`fill ${x} ${Y} ${Z - 30} ${x + 14} ${Y + 10} ${Z + 30} air`); }
  await sleep(3000);
  consoleCmd(`tp Tagger ${X} ${Y} ${Z}`); consoleCmd(`tp Steve ${X + 2} ${Y} ${Z}`); consoleCmd("gamemode survival Tagger"); await sleep(2500); await settle(bot);
  agent.run();
  s.chat("Tagger follow me"); await waitUntil(() => agent.baseGoal?.type === "follow", 30000, 300);
  const followed = agent.baseGoal?.type === "follow";
  s.chat(`Tagger go to ${X - 15} ${Y} ${Z + 10}`);
  const arrived = await waitUntil(() => !agent.goal && bot.entity.position.distanceTo({ x: X - 15, y: Y, z: Z + 10 }) < 3, 60000, 500);
  consoleCmd(`tp Steve ${X + 20} ${Y} ${Z - 15}`); await sleep(8000);
  const stayed = bot.entity.position.distanceTo({ x: X - 15, y: Y, z: Z + 10 }) < 4 && agent.baseGoal?.type !== "follow";
  console.log(`followed: ${followed} | arrived: ${arrived} | stayed instead of following again: ${stayed} (base ${agent.baseGoal?.type})`);
  const pass = followed && arrived && stayed;
  console.log(pass ? "PASS follow ends with new work" : "FAIL");
  consoleCmd("forceload remove all"); agent.stop(); bot.quit(); s.quit(); process.exit(pass ? 0 : 1);
})();
