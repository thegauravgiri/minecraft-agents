const mineflayer = require("mineflayer");
const { connect, consoleCmd, botCmd, sleep, waitUntil, settle } = require("./harness");
(async () => {
  const mk = () => new Promise((r) => { const s = mineflayer.createBot({ host: "localhost", port: 25599, username: "Steve", auth: "offline", version: "26.1.2" }); s.once("spawn", () => r(s)); });
  const s = await mk();
  consoleCmd("op Steve"); consoleCmd("difficulty peaceful"); consoleCmd("gamemode survival Steve"); consoleCmd("gamemode survival MemBot");
  let { bot, agent } = await connect("MemBot");
  consoleCmd("tp MemBot 150 90 -150"); await settle(bot);
  agent.run();
  const base = bot.entity.position.floored().offset(18, 0, -12);
  s.chat(`our base is at ${base.x} ${base.y} ${base.z} by the way`);   // not addressed: must still be remembered
  await sleep(1500);
  console.log("places stored:", JSON.stringify(agent.ctxStore.places.map((p) => [p.label, p.x, p.y, p.z])));
  agent.stop(); bot.quit(); await sleep(2500);
  // fresh process state: new bot, new agent, context reloaded from disk
  ({ bot, agent } = await connect("MemBot"));
  consoleCmd("tp MemBot 150 90 -150"); await settle(bot);
  agent.run();
  console.log("restored places:", agent.ctxStore.places.length);
  s.chat("MemBot go to base");
  const ok = await waitUntil(() => bot.entity.position.distanceTo({ x: base.x, y: base.y, z: base.z }) < 6, 60000, 500);
  console.log(ok ? "PASS remembered base across restart" : "FAIL", "pos", bot.entity.position.floored().toString(), "base", base.toString());
  agent.stop(); bot.quit(); s.quit(); process.exit(ok ? 0 : 1);
})();
