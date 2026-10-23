// Chat-driven goals through the full path (chat -> intent -> goal -> plan -> skills -> verify).
const mineflayer = require("mineflayer");
const { connect, consoleCmd, botCmd, sleep, waitUntil, settle } = require("./harness");
const only = process.argv[2];
(async () => {
  const { bot, agent } = await connect("ChatBot");
  const s = mineflayer.createBot({ host: "localhost", port: 25599, username: "Steve", auth: "offline", version: "26.1.2" });
  await new Promise((r) => s.once("spawn", r));
  consoleCmd("op Steve"); consoleCmd("difficulty peaceful"); consoleCmd("time set day");
  consoleCmd("gamemode survival Steve"); consoleCmd("gamemode survival ChatBot");
  await botCmd(bot, "clear @s"); consoleCmd("clear Steve");
  await sleep(500);
  consoleCmd("tp ChatBot 150 90 -150"); await sleep(1500); consoleCmd("tp Steve ChatBot"); await settle(bot);
  agent.run();
  const say = (m) => s.chat(m);
  const results = [];
  const check = async (name, fn) => { if (only && only !== name) return; const t = Date.now(); let ok = false; try { ok = await fn(); } catch (e) { console.log(name, "threw", e.message); } results.push([name, ok, Date.now() - t]); console.log(ok ? "PASS" : "FAIL", name, `${Date.now() - t}ms`); };

  await check("set_spawn", async () => {
    await botCmd(bot, "give @s white_bed");
    say("ChatBot set spawn");
    return (await waitUntil(() => agent.mem.recall("bed") && !agent.goal, 40000, 500)) && !!bot.spawnPoint;
  });
  await check("sequence", async () => {
    await botCmd(bot, "give @s white_bed");
    const t = bot.entity.position.floored().offset(14, 0, 8);
    const msgs = [];
    s.on("chat", (u, m) => { if (u === "ChatBot") msgs.push(m); });
    say(`ChatBot come to ${t.x} ${t.y} ${t.z} and set a spawn point in the bed`);
    const done = await waitUntil(() => !agent.goal && agent.queue.length === 0 && agent.mem.recall("bed"), 60000, 500);
    console.log("narration:", JSON.stringify(msgs));
    return done && bot.entity.position.distanceTo(t) < 25;
  });
  await check("house", async () => {
    consoleCmd(`tp ChatBot 330 90 -250`); await settle(bot);
    const b = bot.entity.position.floored();
    consoleCmd(`fill ${b.x - 8} ${b.y - 1} ${b.z - 8} ${b.x + 8} ${b.y - 1} ${b.z + 8} grass_block`);
    consoleCmd(`fill ${b.x - 8} ${b.y} ${b.z - 8} ${b.x + 8} ${b.y + 8} ${b.z + 8} air`);
    await botCmd(bot, "give @s oak_planks 72"); await botCmd(bot, "give @s oak_door"); await botCmd(bot, "give @s glass 2"); await botCmd(bot, "give @s dirt 32");
    await sleep(1000); consoleCmd("tp Steve ChatBot");
    say("ChatBot build a house");
    return waitUntil(() => !agent.goal && agent.mem.recall("house"), 200000, 1000);
  });
  await check("give", async () => {
    await botCmd(bot, "give @s diamond 5");
    const had = () => (s.inventory.items().find((i) => i.name === "diamond")?.count || 0);
    say("ChatBot give me 3 diamonds");
    return waitUntil(() => had() >= 3, 40000, 500);
  });
  await check("collect", async () => {
    consoleCmd(`summon item ${Math.floor(bot.entity.position.x) + 5} ${Math.floor(bot.entity.position.y)} ${Math.floor(bot.entity.position.z)} {Item:{id:"minecraft:emerald",count:3}}`);
    await sleep(1500);
    say("ChatBot pick up the dropped items");
    return waitUntil(() => (bot.inventory.items().find((i) => i.name === "emerald")?.count || 0) >= 3, 30000, 500);
  });
  await check("stop", async () => {
    say("ChatBot get 20 oak logs");
    await sleep(3000);
    say("ChatBot stop");
    await sleep(1500);
    return !agent.goal && !agent.current;
  });
  await check("status", async () => {
    let reply = null;
    s.on("chat", (u, m) => { if (u === "ChatBot") reply = m; });
    say("ChatBot what are you doing?");
    return (await waitUntil(() => reply, 8000, 200)) && /idle|following|hp/i.test(reply);
  });
  const pass = results.every((r) => r[1]);
  console.log(JSON.stringify(results));
  agent.stop(); bot.quit(); s.quit(); process.exit(pass ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(2); });
