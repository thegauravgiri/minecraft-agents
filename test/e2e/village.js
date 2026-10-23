// "Everyone, build a village together": ONE leader plans, jobs are split without duplicates, people announce what they take, and it gets built.
process.env.MC_AGENT_NAMES = "Alpha,Beta,Gamma,Delta"; process.env.MC_GENERIC_TRIGGER = "false";
const os = require("os"), path = require("path");
process.env.MC_SHARED_DIR = path.join(os.tmpdir(), "mcbot-village-" + Date.now());
const mineflayer = require("mineflayer");
const { Vec3 } = require("vec3");
const { createAgentBot } = require("../../src/index");
const { consoleCmd, sleep, waitUntil } = require("./harness");
const board = require("../../src/runtime/project");
const names = ["Alpha", "Beta", "Gamma", "Delta"];
(async () => {
  const bots = [];
  for (const n of names) { process.env.BOT_DATA_DIR = path.join(os.tmpdir(), `mcbot-village-${n}-${Date.now()}`); bots.push(createAgentBot({ port: 25599, username: n })); await bots[bots.length - 1].ready; }
  const human = await new Promise((r) => { const b = mineflayer.createBot({ host: "localhost", port: 25599, username: "Mayor", auth: "offline", version: "26.1.2" }); b.once("spawn", () => r(b)); });
  consoleCmd("op Mayor"); consoleCmd("difficulty peaceful"); consoleCmd("time set day");
  const X = 700, Z = 700, Y = 150;
  consoleCmd(`forceload add ${X - 50} ${Z - 50} ${X + 50} ${Z + 50}`); await sleep(2500);
  for (let x = X - 50; x <= X + 50; x += 25) for (let z = Z - 50; z <= Z + 50; z += 25) {
    consoleCmd(`fill ${x} ${Y - 8} ${z} ${x + 24} ${Y - 2} ${z + 24} stone`); consoleCmd(`fill ${x} ${Y - 1} ${z} ${x + 24} ${Y - 1} ${z + 24} grass_block`);
    for (let y = Y; y <= Y + 16; y += 8) consoleCmd(`fill ${x} ${y} ${z} ${x + 24} ${Math.min(y + 7, Y + 16)} ${z + 24} air`);
  }
  await waitUntil(() => bots[0].bot.blockAt(new Vec3(X, Y - 1, Z))?.name === "grass_block" && bots[0].bot.blockAt(new Vec3(X + 30, Y + 4, Z + 30))?.name === "air", 40000, 500);
  names.forEach((n, i) => consoleCmd(`tp ${n} ${X + i * 2} ${Y} ${Z + 4}`)); consoleCmd(`tp Mayor ${X} ${Y} ${Z}`); await sleep(2500);
  names.forEach((n) => consoleCmd(`gamemode creative ${n}`)); await sleep(1500);
  const lines = []; human.on("chat", (u, m) => { if (names.includes(u)) lines.push(`<${u}> ${m}`); });
  const t0 = Date.now();
  human.chat("everyone work together to build a small village here: a well, two houses and a farm. discuss and split the jobs, then go");
  await waitUntil(() => board.active().length || (board.get && false), 90000, 500);
  const pid = board.active()[0]?.id;
  console.log("projects created:", board.active().length, "id", pid);
  await sleep(45000);
  const snapshot = board.tasks(pid).map((t) => `${t.title}->${t.owner || "-"}(${t.state})`);
  console.log("after 45s:", snapshot.join(" | "));
  const owners = board.tasks(pid).map((t) => t.owner).filter(Boolean);
  const dup = owners.length !== new Set(owners).size;
  await waitUntil(() => { const p = board.get(pid); return p && (p.state === "done" || p.state === "partial"); }, 900000, 3000);
  const ts = board.tasks(pid);
  console.log("finished in", Math.round((Date.now() - t0) / 1000) + "s; project", board.get(pid)?.state, "|", ts.map((t) => `${t.title}->${t.owner}(${t.state})`).join(" | "));
  console.log("chat:\n  " + lines.slice(0, 24).join("\n  "));
  const pass = board.active().length <= 1 && ts.length >= 3 && ts.every((t) => t.state === "done") && !dup;
  console.log(pass ? "PASS village built by a coordinated team" : `FAIL (duplicate owners at 45s: ${dup})`);
  bots.forEach((b) => { b.agent.stop(); b.bot.quit(); }); human.quit(); process.exit(pass ? 0 : 1);
})();
