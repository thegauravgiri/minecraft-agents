// Buried stone under dirt: the bot must dig the dirt FIRST (no x-ray), collect, and not get stuck in the pit.
const mineflayer = require("mineflayer");
const { Vec3 } = require("vec3");
const { connect, consoleCmd, botCmd, sleep, waitUntil, settle } = require("./harness");
(async () => {
  const { bot, agent } = await connect("XrayBot");
  const s = mineflayer.createBot({ host: "localhost", port: 25599, username: "Steve", auth: "offline", version: "26.1.2" });
  await new Promise((r) => s.once("spawn", r)); consoleCmd("op Steve");
  consoleCmd("difficulty peaceful"); consoleCmd("time set day"); consoleCmd("gamemode survival XrayBot");
  await settle(bot);
  const P = bot.entity.position.floored(); const X = P.x, Z = P.z, Y = P.y;
  consoleCmd(`fill ${X - 12} ${Y - 40} ${Z - 12} ${X + 12} ${Y - 5} ${Z + 12} dirt`);             // everything below is DIRT ...
  consoleCmd(`fill ${X - 12} ${Y - 1} ${Z - 12} ${X + 12} ${Y - 1} ${Z + 12} grass_block`);
  consoleCmd(`fill ${X - 12} ${Y} ${Z - 12} ${X + 12} ${Y + 8} ${Z + 12} air`);
  consoleCmd(`fill ${X + 1} ${Y - 5} ${Z - 1} ${X + 5} ${Y - 4} ${Z + 1} stone`);                  // ... except this small stone pocket, 3 blocks under the surface
  await waitUntil(() => bot.blockAt(new Vec3(X + 3, Y - 4, Z))?.name === "stone" && bot.blockAt(new Vec3(X + 3, Y + 2, Z))?.name === "air", 15000, 300);
  consoleCmd(`tp XrayBot ${X + 3} ${Y} ${Z}`); await settle(bot);
  await botCmd(bot, "clear @s"); await botCmd(bot, "give @s iron_pickaxe"); await botCmd(bot, "give @s iron_shovel");
  agent.run();
  // watch every dig: was the target ever dug while something solid hid it?
  const { blockerBetween } = require("../../src/skills/blocks");
  let xrays = 0, digs = 0;
  const orig = bot.dig.bind(bot);
  bot.dig = (b, ...a) => { digs++; const blocker = blockerBetween(bot, b); if (blocker && blocker.boundingBox === "block") { xrays++; console.log("XRAY dig of", b.name, "hidden behind", blocker.name); } return orig(b, ...a); };
  s.chat("XrayBot get 6 cobblestone");
  const n = () => bot.inventory.items().filter((i) => i.name === "cobblestone").reduce((a, i) => a + i.count, 0);
  const ok = await waitUntil(() => n() >= 6, 90000, 500);
  console.log(ok ? "PASS" : "FAIL", "cobblestone", n(), "| digs", digs, "| x-ray digs", xrays, "| y", bot.entity.position.y.toFixed(1), "(surface", Y + ")");
  agent.stop(); bot.quit(); s.quit(); process.exit(ok && xrays === 0 ? 0 : 1);
})();
