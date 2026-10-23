// "Renovate the village": damaged houses get repaired, a pit in the ground is filled, paths are laid to the doors.
process.env.MC_AGENT_NAMES = "VillBot"; process.env.MC_AUTONOMY = "on"; process.env.MC_BANTER = "off";
const mineflayer = require("mineflayer");
const { Vec3 } = require("vec3");
const { connect, consoleCmd, sleep, waitUntil, settle } = require("./harness");
(async () => {
  const { bot, agent } = await connect("VillBot");
  const s = mineflayer.createBot({ host: "localhost", port: 25599, username: "Steve", auth: "offline", version: "26.1.2" });
  await new Promise((r) => s.once("spawn", r)); consoleCmd("op Steve"); consoleCmd("gamemode creative Steve"); consoleCmd("difficulty peaceful"); consoleCmd("time set day"); consoleCmd("gamerule doDaylightCycle false");
  const X = 2900, Z = 2900, Y = 150;
  consoleCmd(`forceload add ${X - 40} ${Z - 40} ${X + 40} ${Z + 40}`); await sleep(2000);
  for (let x = X - 40; x <= X + 40; x += 20) { consoleCmd(`fill ${x} ${Y - 5} ${Z - 40} ${x + 19} ${Y - 2} ${Z + 40} dirt`); consoleCmd(`fill ${x} ${Y - 1} ${Z - 40} ${x + 19} ${Y - 1} ${Z + 40} grass_block`); consoleCmd(`fill ${x} ${Y} ${Z - 40} ${x + 19} ${Y + 12} ${Z + 40} air`); }
  await sleep(5000);
  const house = (hx, hz, holes) => {
    consoleCmd(`fill ${hx} ${Y - 1} ${hz} ${hx + 6} ${Y - 1} ${hz + 6} oak_planks`); consoleCmd(`fill ${hx} ${Y} ${hz} ${hx + 6} ${Y + 3} ${hz + 6} oak_planks hollow`); consoleCmd(`fill ${hx} ${Y + 4} ${hz} ${hx + 6} ${Y + 4} ${hz + 6} oak_planks`);
    consoleCmd(`setblock ${hx + 3} ${Y} ${hz} oak_door[half=lower,facing=north]`); consoleCmd(`setblock ${hx + 3} ${Y + 1} ${hz} oak_door[half=upper,facing=north]`);
    for (const [x, y, z] of holes) consoleCmd(`setblock ${x} ${y} ${z} air`);
  };
  const holesA = [[X + 12 + 1, Y + 2, Z + 10], [X + 12 + 6, Y + 1, Z + 13], [X + 12 + 3, Y + 4, Z + 13]];
  const holesB = [[X - 18, Y + 2, Z + 10 + 4]];
  house(X + 12, Z + 10, holesA); house(X - 18, Z + 10, holesB);
  consoleCmd(`fill ${X + 2} ${Y - 2} ${Z - 6} ${X + 4} ${Y - 1} ${Z - 4} air`);          // a pit in the village ground
  await sleep(2500);
  consoleCmd(`tp VillBot ${X} ${Y} ${Z}`); consoleCmd("gamemode creative VillBot"); consoleCmd(`tp Steve ${X} ${Y} ${Z - 1}`); await sleep(2500); await settle(bot);
  agent.run();
  s.chat("VillBot renovate the village here");
  const t0 = Date.now();
  const allHoles = [...holesA, ...holesB];
  const countPaths = () => { let n = 0; for (let x = X - 25; x <= X + 25; x++) for (let z = Z - 25; z <= Z + 25; z++) if (bot.blockAt(new Vec3(x, Y - 1, z))?.name === "dirt_path") n++; return n; };
  const done = () => countPaths() >= 20 && allHoles.every(([x, y, z]) => bot.blockAt(new Vec3(x, y, z))?.name === "oak_planks") && bot.blockAt(new Vec3(X + 3, Y - 1, Z - 5))?.boundingBox === "block";
  const ok = await waitUntil(done, 420000, 3000);
  let paths = 0; for (let x = X - 25; x <= X + 25; x++) for (let z = Z - 25; z <= Z + 25; z++) if (bot.blockAt(new Vec3(x, Y - 1, z))?.name === "dirt_path") paths++;
  const holesLeft = allHoles.filter(([x, y, z]) => bot.blockAt(new Vec3(x, y, z))?.name !== "oak_planks").length;
  console.log(`holes left ${holesLeft}/${allHoles.length} | pit filled: ${bot.blockAt(new Vec3(X + 3, Y - 1, Z - 5))?.name} | dirt paths: ${paths} | ${Math.round((Date.now() - t0) / 1000)}s`);
  const pass = ok && paths >= 8;
  console.log(pass ? "PASS village renovated" : "FAIL");
  consoleCmd("gamerule doDaylightCycle true");
  agent.stop(); bot.quit(); s.quit(); process.exit(pass ? 0 : 1);
})();
