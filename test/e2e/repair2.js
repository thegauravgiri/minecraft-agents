// Real repair: holes, a dirt patch in the wall, a missing door, junk inside, a dirt pillar outside - then "fill the holes in the ground".
process.env.MC_AUTONOMY = "off"; process.env.MC_BANTER = "off";
const mineflayer = require("mineflayer");
const { Vec3 } = require("vec3");
const { connect, consoleCmd, sleep, waitUntil, settle } = require("./harness");
const GM = process.env.GM || "creative";
(async () => {
  const { bot, agent } = await connect("FixBot");
  const s = mineflayer.createBot({ host: "localhost", port: 25599, username: "Steve", auth: "offline", version: "26.1.2" });
  await new Promise((r) => s.once("spawn", r)); consoleCmd("op Steve"); consoleCmd("gamemode creative Steve"); consoleCmd("difficulty peaceful"); consoleCmd("time set day"); consoleCmd("gamerule doDaylightCycle false");
  const X = 3300, Z = 3300, Y = 150;
  consoleCmd(`forceload add ${X - 30} ${Z - 30} ${X + 30} ${Z + 30}`); await sleep(1500);
  for (let x = X - 30; x <= X + 30; x += 20) { consoleCmd(`fill ${x} ${Y - 6} ${Z - 30} ${x + 19} ${Y - 2} ${Z + 30} dirt`); consoleCmd(`fill ${x} ${Y - 1} ${Z - 30} ${x + 19} ${Y - 1} ${Z + 30} grass_block`); consoleCmd(`fill ${x} ${Y} ${Z - 30} ${x + 19} ${Y + 12} ${Z + 30} air`); }
  await sleep(4000);
  consoleCmd(`fill ${X} ${Y - 1} ${Z} ${X + 6} ${Y - 1} ${Z + 6} oak_planks`); consoleCmd(`fill ${X} ${Y} ${Z} ${X + 6} ${Y + 3} ${Z + 6} oak_planks hollow`); consoleCmd(`fill ${X} ${Y + 4} ${Z} ${X + 6} ${Y + 4} ${Z + 6} oak_planks`);
  consoleCmd(`fill ${X + 1} ${Y} ${Z + 1} ${X + 5} ${Y + 3} ${Z + 5} air`);                           // a clean interior (old runs leave stuff)
  consoleCmd(`fill ${X + 3} ${Y} ${Z} ${X + 3} ${Y + 1} ${Z} air`);                                   // doorway WITHOUT a door
  const holes = [[X + 1, Y + 1, Z], [X + 6, Y + 2, Z + 3], [X + 3, Y + 4, Z + 3], [X, Y + 1, Z + 4]];
  for (const [x, y, z] of holes) consoleCmd(`setblock ${x} ${y} ${z} air`);
  consoleCmd(`setblock ${X + 5} ${Y + 2} ${Z + 6} dirt`);                                           // a dirt patch in the plank wall
  consoleCmd(`setblock ${X + 2} ${Y} ${Z + 2} dirt`); consoleCmd(`setblock ${X + 4} ${Y + 1} ${Z + 4} cobblestone`);   // junk inside
  consoleCmd(`fill ${X + 9} ${Y} ${Z + 2} ${X + 9} ${Y + 2} ${Z + 2} dirt`);                         // a dirt pillar next to it
  consoleCmd(`fill ${X - 6} ${Y - 2} ${Z + 2} ${X - 4} ${Y - 1} ${Z + 4} air`);                      // a pit in the ground
  await sleep(2500);
  consoleCmd(`tp FixBot ${X + 3} ${Y} ${Z - 6}`); consoleCmd(`gamemode ${GM} FixBot`); consoleCmd("clear FixBot");
  if (GM !== "creative") for (const it of ["oak_planks 32", "oak_door 2", "dirt 40", "stone_pickaxe", "stone_shovel", "stone_axe", "stone_sword"]) consoleCmd(`give FixBot ${it}`);
  consoleCmd(`tp Steve ${X + 3} ${Y} ${Z - 3}`); await sleep(2500); await settle(bot);
  await s.look(Math.PI, -0.2, true); await sleep(600);
  { const at0 = (x, y, z) => bot.blockAt(new Vec3(x, y, z))?.name; console.log("fixture check:", [[1,0,2],[3,0,2],[2,0,1],[2,0,3],[2,0,2]].map(([a,b,c]) => at0(X+a, Y+b, Z+c)).join(",")); }
  agent.run();
  const said = []; s.on("chat", (u, m) => { if (u === "FixBot") said.push(m); });
  s.chat("FixBot repair this house");
  const at = (x, y, z) => bot.blockAt(new Vec3(x, y, z))?.name;
  const t0 = Date.now();
  const houseOk = () => holes.every(([x, y, z]) => at(x, y, z) === "oak_planks") && at(X + 5, Y + 2, Z + 6) === "oak_planks" && /door/.test(at(X + 3, Y, Z) || "") && at(X + 2, Y, Z + 2) === "air" && at(X + 4, Y + 1, Z + 4) === "air" && at(X + 9, Y + 1, Z + 2) === "air";
  const ok1 = await waitUntil(houseOk, 240000, 2000);
  console.log(`house: holes ${holes.filter(([x, y, z]) => at(x, y, z) === "oak_planks").length}/${holes.length}, patch ${at(X + 5, Y + 2, Z + 6)}, door ${at(X + 3, Y, Z)}, inside junk ${at(X + 2, Y, Z + 2)}/${at(X + 4, Y + 1, Z + 4)}, pillar ${at(X + 9, Y + 1, Z + 2)} | ${Math.round((Date.now() - t0) / 1000)}s`);
  await waitUntil(() => !agent.goal, 30000, 500);
  consoleCmd(`tp Steve ${X - 5} ${Y} ${Z + 7}`); await sleep(1500);
  s.chat("FixBot fill the holes in the ground here");
  const ok2 = await waitUntil(() => at(X - 5, Y - 1, Z + 3) !== "air" && at(X - 5, Y - 2, Z + 3) !== "air", 180000, 2000);
  console.log(`ground pit filled: ${ok2} (${at(X - 5, Y - 1, Z + 3)}) | said: ${JSON.stringify(said.slice(0, 5))}`);
  const pass = ok1 && ok2;
  console.log(pass ? "PASS repair + fix-up" : "FAIL");
  consoleCmd("gamerule doDaylightCycle true");
  agent.stop(); bot.quit(); s.quit(); process.exit(pass ? 0 : 1);
})();
