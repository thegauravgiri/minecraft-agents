const mineflayer = require("mineflayer");
const { connect, consoleCmd, botCmd, sleep, waitUntil } = require("./harness");
const scenario = process.argv[2] || "pillar";
(async () => {
  const { bot, agent } = await connect();
  const s = mineflayer.createBot({ host: "localhost", port: 25599, username: "Steve", auth: "offline", version: "26.1.2" });
  await new Promise((r) => s.once("spawn", r));
  consoleCmd("op Steve"); consoleCmd("difficulty peaceful"); consoleCmd("time set day"); consoleCmd("kill @e[type=!minecraft:player]");
  await botCmd(bot, "gamemode survival"); await botCmd(bot, "clear @s");
  await botCmd(bot, "give @s iron_sword"); await botCmd(bot, "give @s cobblestone 16");
  consoleCmd("gamemode survival Steve"); consoleCmd("clear Steve");
  await sleep(500);
  consoleCmd("tp Vesper -30 80 60"); await sleep(1200);
  const b = bot.entity.position.floored();
  if (scenario === "pillar") {
    // 7-high stone column, Steve on top
    for (let y = 0; y < 7; y++) consoleCmd(`setblock ${b.x + 6} ${b.y + y} ${b.z} stone`);
    consoleCmd(`tp Steve ${b.x + 6} ${b.y + 7} ${b.z}`);
  } else if (scenario === "far") {
    consoleCmd("effect give Steve slow_falling 40 0 true"); consoleCmd(`tp Steve ${b.x + 70} ${b.y + 30} ${b.z + 40}`);
  } else if (scenario === "below") {
    consoleCmd(`fill ${b.x + 4} ${b.y - 8} ${b.z - 1} ${b.x + 6} ${b.y - 1} ${b.z + 1} air`);
    consoleCmd(`tp Steve ${b.x + 5} ${b.y - 8} ${b.z}`);
  }
  await sleep(1500);
  agent.run();
  s.chat("Vesper kill Steve");
  const dead = () => !s.entity || s.health <= 0 || agent.kills.has("steve");
  const ok = await waitUntil(() => agent.kills.has("steve"), 90000, 500);
  console.log(ok ? `PASS ${scenario}: target killed` : `FAIL ${scenario}: not killed`, "bot hp", bot.health.toFixed(1), agent.stats);
  agent.stop(); bot.quit(); s.quit(); process.exit(ok ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(2); });
