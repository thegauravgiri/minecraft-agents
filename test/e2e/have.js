const { connect, consoleCmd, botCmd, sleep, waitUntil } = require("./harness");
const item = process.argv[2] || "wooden_pickaxe";
const count = parseInt(process.argv[3] || "1", 10);
const maxMs = parseInt(process.argv[4] || "240000", 10);
(async () => {
  const { bot, agent } = await connect();
  consoleCmd("difficulty peaceful"); consoleCmd("time set day"); consoleCmd("gamerule advance_time false");
  await botCmd(bot, "gamemode survival"); await botCmd(bot, "clear @s");
  await sleep(500);
  console.log("start pos", bot.entity.position, "dim", bot.game.dimension);
  agent.run();
  agent.setGoal({ type: "have", items: { [item]: count } });
  const inv = () => bot.inventory.items().reduce((n, i) => n + (i.name === item ? i.count : 0), 0);
  const ok = await waitUntil(() => inv() >= count, maxMs, 1000);
  console.log(ok ? `PASS: have ${inv()} ${item}` : `FAIL: timeout, have ${inv()} ${item}`);
  console.log("inventory:", bot.inventory.items().map((i) => `${i.name}x${i.count}`).join(", "));
  console.log("stats", agent.stats);
  agent.stop(); bot.quit(); process.exit(ok ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(2); });
