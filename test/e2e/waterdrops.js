// Items floating in a pond: how long does the bot take to fetch them all, and does it manage?
const mineflayer = require("mineflayer");
const { Vec3 } = require("vec3");
const { connect, consoleCmd, botCmd, sleep, waitUntil, settle } = require("./harness");
(async () => {
  const { bot, agent } = await connect("PondBot");
  const s = mineflayer.createBot({ host: "localhost", port: 25599, username: "Steve", auth: "offline", version: "26.1.2" });
  await new Promise((r) => s.once("spawn", r)); consoleCmd("op Steve");
  consoleCmd("difficulty peaceful"); consoleCmd("time set day"); consoleCmd("gamemode survival PondBot");
  await settle(bot);
  const P = bot.entity.position.floored(); const X = P.x, Z = P.z, Y = P.y;
  consoleCmd(`fill ${X - 14} ${Y - 30} ${Z - 14} ${X + 14} ${Y - 2} ${Z + 14} stone`); consoleCmd(`fill ${X - 14} ${Y - 1} ${Z - 14} ${X + 14} ${Y - 1} ${Z + 14} grass_block`); consoleCmd(`fill ${X - 14} ${Y} ${Z - 14} ${X + 14} ${Y + 8} ${Z + 14} air`);
  consoleCmd(`fill ${X + 3} ${Y - 5} ${Z - 6} ${X + 13} ${Y - 1} ${Z + 6} water`);                    // pond 11 x 13, 5 deep, east of us
  await waitUntil(() => bot.blockAt(new Vec3(X + 8, Y - 3, Z))?.name === "water" && bot.blockAt(new Vec3(X, Y + 2, Z))?.name === "air", 20000, 300);
  consoleCmd(`tp PondBot ${X} ${Y} ${Z}`); await settle(bot); await botCmd(bot, "clear @s");
  await botCmd(bot, "effect give @s saturation 60 10 true");
  const items = [["diamond", 7, -2, 1], ["emerald", 9, -3, -3], ["gold_ingot", 11, -1, 4], ["iron_ingot", 8, -4, 2], ["coal", 12, -2, -1]];
  for (const [it, dx, dy, dz] of items) consoleCmd(`summon item ${X + dx} ${Y + dy} ${Z + dz} {Item:{id:"minecraft:${it}",count:3},Motion:[0.0,0.0,0.0]}`);
  await sleep(1500);
  const have = () => bot.inventory.items().reduce((a, i) => a + (["diamond", "emerald", "gold_ingot", "iron_ingot", "coal"].includes(i.name) ? i.count : 0), 0);
  agent.run();
  const t0 = Date.now();
  s.chat("PondBot pick up the dropped items");
  const ok = await waitUntil(() => have() >= 15, 120000, 400);
  console.log(`${ok ? "PASS" : "FAIL"} picked ${have()}/15 items from the pond in ${((Date.now() - t0) / 1000).toFixed(0)}s | hp ${bot.health.toFixed(0)} oxygen ${bot.oxygenLevel}`);
  agent.stop(); bot.quit(); s.quit(); process.exit(0);
})();
