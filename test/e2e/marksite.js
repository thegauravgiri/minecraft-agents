// "this is where the village goes": the exact spot is written down and can be asked for later.
const os = require("os"), path = require("path");
process.env.MC_SHARED_DIR = path.join(os.tmpdir(), "mcbot-mark-" + Date.now());
const mineflayer = require("mineflayer");
const { connect, consoleCmd, sleep, waitUntil, settle } = require("./harness");
(async () => {
  const { bot, agent } = await connect("MarkBot");
  const s = mineflayer.createBot({ host: "localhost", port: 25599, username: "Steve", auth: "offline", version: "26.1.2" });
  await new Promise((r) => s.once("spawn", r)); consoleCmd("op Steve"); consoleCmd("gamemode creative Steve");
  consoleCmd("tp Steve 400 120 400"); await sleep(2500);
  const p = s.entity.position.floored();
  agent.run();
  const said = []; s.on("chat", (u, m) => { if (u === "MarkBot") said.push(m); });
  s.chat("MarkBot mark this spot, this is where the village will be built");
  await waitUntil(() => agent.know.items.some((e) => e.kind === "site"), 15000, 300);
  const e = agent.know.items.find((x) => x.kind === "site");
  s.chat("MarkBot where is the village?");
  await waitUntil(() => said.some((m) => /village site is at/.test(m)), 15000, 300);
  const ok = e && Math.abs(e.pos.x - p.x) <= 1 && Math.abs(e.pos.z - p.z) <= 1 && said.some((m) => new RegExp(`x${e.pos.x} y${e.pos.y} z${e.pos.z}`).test(m));
  console.log("marked:", JSON.stringify(e && { label: e.label, pos: e.pos }), "| player at", p.toString(), "| said:", JSON.stringify(said.slice(0, 3)));
  console.log(ok ? "PASS exact place is logged and answerable" : "FAIL");
  agent.stop(); bot.quit(); s.quit(); process.exit(ok ? 0 : 1);
})();
