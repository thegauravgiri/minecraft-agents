// Night, no gear: dig a pit, cap it, wait; at daybreak climb out.
const { connect, consoleCmd, botCmd, sleep, waitUntil, settle } = require("./harness");
const { Vec3 } = require("vec3");
(async () => {
  const { bot, agent } = await connect("BurrowBot");
  consoleCmd("difficulty peaceful"); consoleCmd("gamerule doMobSpawning false"); consoleCmd("gamerule doDaylightCycle false"); consoleCmd("time set midnight");
  const X = 1100, Z = 1100, Y = 150;
  consoleCmd(`forceload add ${X - 20} ${Z - 20} ${X + 20} ${Z + 20}`); await sleep(1500);
  consoleCmd(`fill ${X - 15} ${Y - 10} ${Z - 15} ${X + 15} ${Y - 2} ${Z + 15} dirt`); consoleCmd(`fill ${X - 15} ${Y - 1} ${Z - 15} ${X + 15} ${Y - 1} ${Z + 15} grass_block`); consoleCmd(`fill ${X - 15} ${Y} ${Z - 15} ${X + 15} ${Y + 8} ${Z + 15} air`);
  await waitUntil(() => bot.blockAt(new Vec3(X, Y - 1, Z))?.name === "grass_block" && bot.blockAt(new Vec3(X, Y + 3, Z))?.name === "air", 20000, 300);
  consoleCmd("gamemode survival BurrowBot"); consoleCmd("clear BurrowBot"); consoleCmd(`tp BurrowBot ${X} ${Y} ${Z}`); await sleep(2500); await settle(bot);
  const y0 = bot.entity.position.y;
  const run = agent.exec({ skill: "burrow", args: {} }, false);
  await waitUntil(() => bot.entity.position.y < y0 - 1.5, 25000, 300);
  await sleep(2500);
  const below = y0 - bot.entity.position.y;
  const capped = bot.blockAt(bot.entity.position.floored().offset(0, 2, 0))?.boundingBox === "block";
  console.log(`dug down ${below.toFixed(1)} blocks, capped overhead: ${capped}`);
  consoleCmd("time set day"); 
  const res = await Promise.race([run, sleep(60000).then(() => "TIMEOUT")]);
  await sleep(1500);
  const out = bot.entity.position.y >= y0 - 0.6;
  console.log("burrow result:", JSON.stringify(res).slice(0, 120), "| back on the surface:", out, "y", bot.entity.position.y.toFixed(1), "start", y0.toFixed(1));
  const pass = below >= 1.5 && capped && out;
  console.log(pass ? "PASS night burrow" : "FAIL");
  agent.stop(); bot.quit(); process.exit(pass ? 0 : 1);
})();
