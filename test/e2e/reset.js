// "reset your memory" by chat, and the console script through the inbox.
process.env.MC_AUTONOMY = "off"; process.env.MC_BANTER = "off";
const mineflayer = require("mineflayer");
const { connect, consoleCmd, sleep, waitUntil } = require("./harness");
(async () => {
  const { bot, agent } = await connect("ResetBot");
  const s = mineflayer.createBot({ host: "localhost", port: 25599, username: "Steve", auth: "offline", version: "26.1.2" });
  await new Promise((r) => s.once("spawn", r)); await sleep(1500);
  agent.run(); await sleep(4500);
  agent.ctxStore.addChat("Steve", "our base is at 100 64 -20"); agent.know.add({ kind: "site", label: "base site", pos: { x: 100, y: 64, z: -20 }, source: "player" });
  const before = { chat: agent.ctxStore.chat.length, places: agent.ctxStore.places.length, know: agent.know.items.length };
  s.chat("ResetBot reset your memory");
  await waitUntil(() => agent.ctxStore.places.length === 0, 15000, 300);
  const after = { chat: agent.ctxStore.chat.length, places: agent.ctxStore.places.length, know: agent.know.items.length };
  agent.ctxStore.addChat("Steve", "hello again"); await sleep(500);
  require("child_process").execSync(`node scripts/reset-context.js chat ResetBot`, { env: process.env });
  await waitUntil(() => agent.ctxStore.chat.length === 0, 10000, 300);
  console.log("before", JSON.stringify(before), "| after chat reset", JSON.stringify(after), "| after script:", agent.ctxStore.chat.length);
  // tasks: a running goal + a queue are dropped by chat and the bot stands by
  agent.setGoals([{ type: "have", items: { oak_log: 64 } }, { type: "have", items: { cobblestone: 64 } }]);
  await sleep(1500);
  const busy = !!agent.goal && agent.queue.length === 1;
  s.chat("ResetBot cancel all tasks");
  const dropped = await waitUntil(() => !agent.goal && !agent.queue.length, 15000, 300);
  await sleep(5000);
  const stillIdle = !agent.goal;
  console.log(`tasks: busy before ${busy}, dropped ${dropped}, still idle after 5s ${stillIdle}`);
  const pass = before.places >= 1 && after.places === 0 && after.know <= 1 && after.chat <= 2 && agent.ctxStore.chat.length <= 2 && busy && dropped && stillIdle;
  console.log(pass ? "PASS memory reset (chat + script)" : "FAIL");
  agent.stop(); bot.quit(); s.quit(); process.exit(pass ? 0 : 1);
})();
