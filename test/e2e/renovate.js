// "Renovate this house": the change asked for is made to the existing building, keeping its footprint.
process.env.MC_AUTONOMY = "off"; process.env.MC_BANTER = "off";
const mineflayer = require("mineflayer");
const { Vec3 } = require("vec3");
const { connect, consoleCmd, sleep, waitUntil, settle } = require("./harness");
(async () => {
  const { bot, agent } = await connect("RenoBot");
  const s = mineflayer.createBot({ host: "localhost", port: 25599, username: "Steve", auth: "offline", version: "26.1.2" });
  await new Promise((r) => s.once("spawn", r)); consoleCmd("op Steve"); consoleCmd("gamemode creative Steve"); consoleCmd("difficulty peaceful"); consoleCmd("time set day");
  const X = 3500, Z = 3500, Y = 150;
  consoleCmd(`forceload add ${X - 20} ${Z - 20} ${X + 20} ${Z + 20}`); await sleep(2500);
  consoleCmd(`fill ${X - 20} ${Y - 5} ${Z - 20} ${X + 20} ${Y - 2} ${Z + 20} dirt`); consoleCmd(`fill ${X - 20} ${Y - 1} ${Z - 20} ${X + 20} ${Y - 1} ${Z + 20} grass_block`); consoleCmd(`fill ${X - 20} ${Y} ${Z - 20} ${X + 20} ${Y + 12} ${Z + 20} air`);
  await sleep(2500);
  consoleCmd(`fill ${X} ${Y - 1} ${Z} ${X + 6} ${Y - 1} ${Z + 6} oak_planks`); consoleCmd(`fill ${X} ${Y} ${Z} ${X + 6} ${Y + 3} ${Z + 6} oak_planks hollow`); consoleCmd(`fill ${X} ${Y + 4} ${Z} ${X + 6} ${Y + 4} ${Z + 6} oak_planks`);
  consoleCmd(`fill ${X + 1} ${Y} ${Z + 1} ${X + 5} ${Y + 3} ${Z + 5} air`);
  consoleCmd(`setblock ${X + 3} ${Y} ${Z} oak_door[half=lower,facing=north]`); consoleCmd(`setblock ${X + 3} ${Y + 1} ${Z} oak_door[half=upper,facing=north]`);
  await sleep(2000);
  consoleCmd(`tp RenoBot ${X + 3} ${Y} ${Z - 6}`); consoleCmd("gamemode creative RenoBot"); consoleCmd(`tp Steve ${X + 3} ${Y} ${Z - 3}`); await sleep(2500); await settle(bot);
  await s.look(Math.PI, -0.2, true); await sleep(600);
  agent.run();
  s.chat("RenoBot renovate this house: make the walls stone bricks and put glass windows in them");
  const count = (name) => { let n = 0; for (let x = X; x <= X + 6; x++) for (let z = Z; z <= Z + 6; z++) for (let y = Y; y <= Y + 3; y++) if (bot.blockAt(new Vec3(x, y, z))?.name.includes(name)) n++; return n; };
  const t0 = Date.now();
  const ok = await waitUntil(() => count("stone_brick") >= 40 && count("glass") >= 2, 300000, 3000);
  console.log(`walls: stone bricks ${count("stone_brick")}, glass ${count("glass")}, planks left ${count("oak_planks")}, door ${/door/.test(bot.blockAt(new Vec3(X + 3, Y, Z))?.name || "")} | ${Math.round((Date.now() - t0) / 1000)}s`);
  console.log(ok ? "PASS renovation" : "FAIL");
  agent.stop(); bot.quit(); s.quit(); process.exit(ok ? 0 : 1);
})();
