// Creative mode: items are instant, travel is flying, no gathering/hunger/boat logic.
const mineflayer = require("mineflayer");
const { Vec3 } = require("vec3");
const { connect, consoleCmd, botCmd, sleep, waitUntil, settle } = require("./harness");
(async () => {
  const { bot, agent } = await connect("CreaBot");
  const s = mineflayer.createBot({ host: "localhost", port: 25599, username: "Steve", auth: "offline", version: "26.1.2" });
  await new Promise((r) => s.once("spawn", r)); consoleCmd("op Steve");
  consoleCmd("difficulty peaceful"); consoleCmd("time set day"); consoleCmd("gamemode survival CreaBot");
  await settle(bot);
  const P = bot.entity.position.floored(); const X = P.x, Z = P.z, Y = P.y;
  consoleCmd(`fill ${X - 5} ${Y - 30} ${Z - 5} ${X + 110} ${Y - 2} ${Z + 5} stone`); consoleCmd(`fill ${X - 5} ${Y - 1} ${Z - 5} ${X + 110} ${Y - 1} ${Z + 5} grass_block`); consoleCmd(`fill ${X - 5} ${Y} ${Z - 5} ${X + 110} ${Y + 30} ${Z + 5} air`);
  consoleCmd(`fill ${X + 40} ${Y} ${Z - 5} ${X + 52} ${Y + 14} ${Z + 5} stone`);             // a 14-high, 13-thick wall of rock across the way
  await waitUntil(() => bot.blockAt(new Vec3(X + 45, Y + 5, Z))?.name === "stone" && bot.blockAt(new Vec3(X + 100, Y + 3, Z))?.name === "air", 25000, 300);
  consoleCmd(`tp CreaBot ${X} ${Y} ${Z}`); await settle(bot); consoleCmd("clear CreaBot"); await sleep(300);
  consoleCmd("gamemode creative CreaBot"); consoleCmd("tp Steve CreaBot"); await sleep(1500);
  console.log("bot game mode:", bot.game.gameMode);
  agent.run();
  const results = [];
  const count = (n) => [bot, s].reduce((tot, b) => tot + b.inventory.items().filter((i) => i.name === n).reduce((a, i) => a + i.count, 0), 0);   // "get me X" may be handed to the player: count both

  let t0 = Date.now();
  s.chat("CreaBot get me 3 diamond pickaxes, 70 oak planks and a boat");
  const got = await waitUntil(() => count("diamond_pickaxe") >= 3 && count("oak_planks") >= 70 && [bot, s].some((b) => b.inventory.items().some((i) => /_boat$/.test(i.name))), 40000, 300);
  results.push(["items instantly", got, Date.now() - t0]);
  console.log(got ? "PASS" : "FAIL", "creative items:", `${count("diamond_pickaxe")} pickaxes, ${count("oak_planks")} planks, boat ${[bot, s].some((b) => b.inventory.items().some((i) => /_boat$/.test(i.name)))}`, `${((Date.now() - t0) / 1000).toFixed(1)}s (includes the AI understanding the request)`);

  t0 = Date.now();
  s.chat(`CreaBot go to ${X + 100} ${Y} ${Z}`);
  const there = await waitUntil(() => Math.hypot(bot.entity.position.x - (X + 100), bot.entity.position.z - Z) < 6, 60000, 300);
  results.push(["fly over the hill", there, Date.now() - t0]);
  console.log(there ? "PASS" : "FAIL", `flew 100 blocks over a 14-high rock wall in ${((Date.now() - t0) / 1000).toFixed(1)}s`, "| now at y", bot.entity.position.y.toFixed(1));
  agent.stop(); bot.quit(); s.quit(); process.exit(results.every((r) => r[1]) ? 0 : 1);
})();
