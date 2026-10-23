const mineflayer = require("mineflayer");
const { connect, consoleCmd, botCmd, sleep, waitUntil } = require("./harness");
(async () => {
  const { bot, agent } = await connect();
  const p = mineflayer.createBot({ host: "localhost", port: 25599, username: "Steve", auth: "offline", version: "26.1.2" });
  await new Promise((r) => p.once("spawn", r));
  consoleCmd("difficulty peaceful"); consoleCmd("time set day"); consoleCmd("kill @e[type=!minecraft:player]"); consoleCmd("op Steve");
  await sleep(1000);
  const tp = (x, y, z) => consoleCmd(`tp Steve ${x} ${y} ${z}`);
  consoleCmd("tp Vesper Steve"); await sleep(1500);
  agent.run();
  p.chat("Vesper follow me");
  await sleep(2500);
  const dist = () => bot.entity.position.distanceTo(p.entity.position);
  const base = p.entity.position.clone();
  const samples = [];
  // Steve runs in a big loop by teleport hops + walking
  const hops = [[25, 0], [25, 25], [0, 25], [-20, 10], [0, 0]];
  for (const [dx, dz] of hops) {
    const y = bot.blockAt(base.offset(dx, 0, dz)) ? base.y : base.y;
    consoleCmd(`tp Steve ${Math.floor(base.x + dx)} ${Math.floor(base.y + 3)} ${Math.floor(base.z + dz)}`);
    await sleep(500);
    const ok = await waitUntil(() => p.entity && dist() < 6, 35000, 300);
    samples.push({ hop: [dx, dz], caught: ok, dist: +dist().toFixed(1) });
  }
  console.log(JSON.stringify(samples));
  const pass = samples.every((s) => s.caught);
  console.log(pass ? "PASS follow" : "FAIL follow");
  agent.stop(); bot.quit(); p.quit(); process.exit(pass ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(2); });
