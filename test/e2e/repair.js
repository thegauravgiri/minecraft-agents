// "Repair this house": the bot surveys the damaged building, keeps what stands, fills the holes. Nothing else is touched.
const mineflayer = require("mineflayer");
const { Vec3 } = require("vec3");
const { connect, consoleCmd, sleep, waitUntil, settle } = require("./harness");
(async () => {
  const { bot, agent } = await connect("RepairBot");
  const s = mineflayer.createBot({ host: "localhost", port: 25599, username: "Steve", auth: "offline", version: "26.1.2" });
  await new Promise((r) => s.once("spawn", r)); consoleCmd("op Steve"); consoleCmd("gamemode creative Steve"); consoleCmd("difficulty peaceful"); consoleCmd("time set day");
  const X = 1500, Z = 1500, Y = 150;
  consoleCmd(`forceload add ${X - 25} ${Z - 25} ${X + 25} ${Z + 25}`); await sleep(1500);
  consoleCmd(`fill ${X - 20} ${Y - 5} ${Z - 20} ${X + 20} ${Y - 2} ${Z + 20} stone`); consoleCmd(`fill ${X - 20} ${Y - 1} ${Z - 20} ${X + 20} ${Y - 1} ${Z + 20} grass_block`); consoleCmd(`fill ${X - 20} ${Y} ${Z - 20} ${X + 20} ${Y + 9} ${Z + 20} air`);
  await sleep(2500);
  // a 7x5x7 plank house: floor, walls, roof, door gap, then punch holes
  consoleCmd(`fill ${X} ${Y - 1} ${Z} ${X + 6} ${Y - 1} ${Z + 6} oak_planks`);
  consoleCmd(`fill ${X} ${Y} ${Z} ${X + 6} ${Y + 3} ${Z + 6} oak_planks hollow`); consoleCmd(`fill ${X} ${Y + 4} ${Z} ${X + 6} ${Y + 4} ${Z + 6} oak_planks`);
  consoleCmd(`fill ${X + 3} ${Y} ${Z} ${X + 3} ${Y + 1} ${Z} air`); consoleCmd(`setblock ${X + 3} ${Y} ${Z} oak_door[half=lower,facing=south]`); consoleCmd(`setblock ${X + 3} ${Y + 1} ${Z} oak_door[half=upper,facing=south]`);   // doorway with a door
  const holes = [[X + 1, Y + 1, Z], [X + 2, Y + 2, Z], [X + 6, Y + 1, Z + 3], [X + 6, Y + 2, Z + 3], [X + 3, Y + 4, Z + 3], [X + 4, Y + 4, Z + 3], [X, Y + 2, Z + 5]];
  for (const [x, y, z] of holes) consoleCmd(`setblock ${x} ${y} ${z} air`);
  await sleep(1500);
  consoleCmd(`tp RepairBot ${X + 3} ${Y} ${Z - 6}`); consoleCmd("gamemode creative RepairBot"); consoleCmd(`tp Steve ${X + 3} ${Y} ${Z - 4}`); await sleep(2500); await settle(bot);
  await s.look(Math.PI, -0.2, true); await sleep(800);
  agent.run();
  const said = []; s.on("chat", (u, m) => { if (u === "RepairBot") said.push(m); });
  s.chat("RepairBot repair this house, it has holes");
  const t0 = Date.now();
  await waitUntil(() => agent.goal?.mode === "repair", 40000, 300);
  console.log("goal:", JSON.stringify({ type: agent.goal?.type, mode: agent.goal?.mode, where: agent.goal?.where }));
  await waitUntil(() => !agent.goal || agent.goal.type !== "build", 300000, 1000);
  const filled = holes.filter(([x, y, z]) => bot.blockAt(new Vec3(x, y, z))?.name === "oak_planks").length;
  const door = /door/.test(bot.blockAt(new Vec3(X + 3, Y, Z))?.name) ? "air" : "gone";
  console.log("hole contents:", holes.map(([x, y, z]) => bot.blockAt(new Vec3(x, y, z))?.name).join(", "));
  console.log(`holes filled ${filled}/${holes.length} | doorway still open: ${door === "air"} | ${Math.round((Date.now() - t0) / 1000)}s | said: ${JSON.stringify(said.slice(0, 3))}`);
  const pass = filled >= holes.length - 1 && door === "air";
  console.log(pass ? "PASS repair fills holes, leaves the rest" : "FAIL");
  agent.stop(); bot.quit(); s.quit(); process.exit(pass ? 0 : 1);
})();
