// By chat: "get on the ghast" (harness first), "fly to x z and land", "get off" - and "ride with me" joining the player's ghast.
process.env.MC_AUTONOMY = "off";
const mineflayer = require("mineflayer");
const { connect, consoleCmd, sleep, waitUntil, settle } = require("./harness");
(async () => {
  const { bot, agent } = await connect("GhastBot");
  const s = mineflayer.createBot({ host: "localhost", port: 25599, username: "Steve", auth: "offline", version: "26.1.2" });
  await new Promise((r) => s.once("spawn", r)); consoleCmd("op Steve"); consoleCmd("gamemode creative Steve"); consoleCmd("difficulty peaceful"); consoleCmd("time set day");
  const X = 2300, Z = 2300, Y = 150;
  consoleCmd(`forceload add ${X - 60} ${Z - 30} ${X + 60} ${Z + 30}`); await sleep(2500);
  for (let x = X - 60; x <= X + 60; x += 30) { consoleCmd(`fill ${x} ${Y - 5} ${Z - 30} ${x + 29} ${Y - 2} ${Z + 30} stone`); consoleCmd(`fill ${x} ${Y - 1} ${Z - 30} ${x + 29} ${Y - 1} ${Z + 30} grass_block`); consoleCmd(`fill ${x} ${Y} ${Z - 30} ${x + 29} ${Y + 30} ${Z + 30} air`); }
  await sleep(5000);
  consoleCmd("kill @e[type=happy_ghast]");
  consoleCmd(`tp GhastBot ${X} ${Y} ${Z}`); consoleCmd("gamemode creative GhastBot"); consoleCmd("clear GhastBot"); consoleCmd(`tp Steve ${X + 2} ${Y} ${Z + 3}`);
  consoleCmd(`summon happy_ghast ${X + 4} ${Y + 1} ${Z} {Age:0}`); await sleep(3000); await settle(bot);
  agent.run();
  const say = (m) => s.chat("GhastBot " + m);
  say("get on the happy ghast");
  const got = await waitUntil(() => bot.vehicle?.name === "happy_ghast", 60000, 300);
  console.log("1) mounted:", got, "| harness on ghast:", !!(bot.vehicle?.equipment || [])[6], "| driver:", (bot.vehicle?.passengers || [])[0] === bot.entity);
  const tx = X + 45;
  say(`fly the ghast to ${tx} ${Z} and land there`);
  const landed = await waitUntil(() => !bot.vehicle && Math.hypot(bot.entity.position.x - tx, bot.entity.position.z - Z) < 8 && bot.entity.position.y < Y + 2.5, 120000, 500);
  console.log("2) flew, landed, got off:", landed, "at", bot.entity.position.floored().toString());
  consoleCmd(`tp Steve ${X + 40} ${Y} ${Z + 3}`); await sleep(1500);
  const g = Object.values(s.entities).find((e) => e.name === "happy_ghast");
  await s.lookAt(g.position.offset(0, 2, 0), true); await s.activateEntity(g); await sleep(1500);
  say("ride with me on the ghast");
  const joined = await waitUntil(() => bot.vehicle?.name === "happy_ghast", 60000, 300);
  console.log("3) joined my ghast:", joined, "| seat:", bot.vehicle && (bot.vehicle.passengers || []).indexOf(bot.entity));
  say("get off the ghast");
  const off = await waitUntil(() => !bot.vehicle, 60000, 300);
  console.log("4) got off:", off);
  const pass = got && landed && joined && off;
  console.log(pass ? "PASS ghast by chat" : "FAIL");
  agent.stop(); bot.quit(); s.quit(); process.exit(pass ? 0 : 1);
})();
