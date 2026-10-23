// A real house with a door: "get inside" must use the door and leave every wall block intact.
const mineflayer = require("mineflayer");
const { Vec3 } = require("vec3");
const { connect, consoleCmd, botCmd, sleep, waitUntil, settle } = require("./harness");
(async () => {
  const { bot, agent } = await connect("DoorBot");
  consoleCmd("difficulty peaceful"); consoleCmd("time set day"); consoleCmd("gamemode survival DoorBot");
  consoleCmd("tp DoorBot 400 150 400"); await sleep(3000);
  consoleCmd("forceload add 380 380 420 420"); await sleep(500);
  const X = 400, Y = 140, Z = 400;
  await botCmd(bot, `fill ${X - 12} ${Y - 1} ${Z - 12} ${X + 14} ${Y - 1} ${Z + 14} stone`);
  await botCmd(bot, `fill ${X - 12} ${Y} ${Z - 12} ${X + 14} ${Y + 8} ${Z + 14} air`);
  // 5x5 stone-brick house, 3 high, roof, door on the south side (z = Z+4)
  await botCmd(bot, `fill ${X} ${Y - 1} ${Z} ${X + 4} ${Y + 3} ${Z + 4} cobblestone hollow`);
  await botCmd(bot, `setblock ${X + 2} ${Y} ${Z + 4} oak_door[half=lower,facing=south,hinge=left,open=false]`);
  await botCmd(bot, `setblock ${X + 2} ${Y + 1} ${Z + 4} oak_door[half=upper,facing=south,hinge=left,open=false]`);
  await waitUntil(() => bot.blockAt(new Vec3(X + 2, Y + 1, Z + 4))?.name === "oak_door", 8000, 200);
  const countBricks = () => { let n = 0; for (let x = X; x <= X + 4; x++) for (let y = Y - 1; y <= Y + 3; y++) for (let z = Z; z <= Z + 4; z++) if (bot.blockAt(new Vec3(x, y, z))?.name === "cobblestone") n++; return n; };
  const before = countBricks();
  await botCmd(bot, "clear @s"); await botCmd(bot, "give @s iron_pickaxe");  // a pickaxe makes breaking the wall tempting
  consoleCmd(`tp DoorBot ${X + 9} ${Y} ${Z + 9}`); await settle(bot);
  const s = mineflayer.createBot({ host: "localhost", port: 25599, username: "Steve", auth: "offline", version: "26.1.2" });
  await new Promise((r) => s.once("spawn", r)); consoleCmd("op Steve"); await sleep(600);
  agent.run();
  s.chat(`DoorBot go to ${X + 2} ${Y} ${Z + 2}`);
  const inside = () => { const p = bot.entity.position; return p.x > X && p.x < X + 4 && p.z > Z && p.z < Z + 4 && p.y >= Y && p.y < Y + 3; };
  const ok = await waitUntil(inside, 60000, 300);
  const after = countBricks();
  console.log(ok ? "inside" : "NOT inside", "| wall blocks before", before, "after", after, "| door:", bot.blockAt(new Vec3(X + 2, Y, Z + 4))?.name);
  const pass = ok && after === before;
  console.log(pass ? "PASS entered via the door, walls intact" : "FAIL");
  agent.stop(); bot.quit(); s.quit(); process.exit(pass ? 0 : 1);
})();
