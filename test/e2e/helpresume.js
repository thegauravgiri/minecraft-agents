// A help call must not cost the job: Beta is building what the player asked, Alpha gets jumped, Beta runs over, fights - and goes BACK to the build.
// Then "Alpha, finish it with Beta"-style talk: "Beta, finish it with Alpha" -> Beta continues its own build, Alpha comes to help (Beta leads, not the alphabetical first).
process.env.MC_AGENT_NAMES = "Alpha,Beta"; process.env.MC_GENERIC_TRIGGER = "false"; process.env.MC_AUTONOMY = "on"; process.env.MC_BANTER = "off";
const os = require("os"), path = require("path");
process.env.MC_SHARED_DIR = path.join(os.tmpdir(), "mcbot-helpresume-" + Date.now());
const mineflayer = require("mineflayer");
const { createAgentBot } = require("../../src/index");
const { consoleCmd, sleep, waitUntil } = require("./harness");
(async () => {
  process.env.BOT_DATA_DIR = path.join(os.tmpdir(), "mcbot-hr-a-" + Date.now()); const A = createAgentBot({ port: 25599, username: "Alpha" }); await A.ready;
  process.env.BOT_DATA_DIR = path.join(os.tmpdir(), "mcbot-hr-b-" + Date.now()); const B = createAgentBot({ port: 25599, username: "Beta" }); await B.ready;
  const w = await new Promise((r) => { const b = mineflayer.createBot({ host: "localhost", port: 25599, username: "Watcher", auth: "offline", version: "26.1.2" }); b.once("spawn", () => r(b)); });
  consoleCmd("op Watcher"); consoleCmd("difficulty normal"); consoleCmd("gamerule doMobSpawning false"); consoleCmd("time set noon"); consoleCmd("gamerule doDaylightCycle false");
  const X = 1100, Z = 900, Y = 150;
  consoleCmd(`forceload add ${X - 60} ${Z - 30} ${X + 60} ${Z + 30}`); await sleep(2000);
  for (let x = X - 60; x <= X + 60; x += 30) { consoleCmd(`fill ${x} ${Y - 6} ${Z - 30} ${x + 29} ${Y - 2} ${Z + 30} stone`); consoleCmd(`fill ${x} ${Y - 1} ${Z - 30} ${x + 29} ${Y - 1} ${Z + 30} grass_block`); consoleCmd(`fill ${x} ${Y} ${Z - 30} ${x + 29} ${Y + 20} ${Z + 30} air`); }
  await sleep(4000);
  consoleCmd(`tp Alpha ${X - 25} ${Y} ${Z}`); consoleCmd(`tp Beta ${X} ${Y} ${Z}`); consoleCmd(`tp Watcher ${X} ${Y} ${Z + 2}`); await sleep(3000);
  for (const n of ["Alpha", "Beta"]) { consoleCmd(`gamemode survival ${n}`); consoleCmd(`clear ${n}`); consoleCmd(`give ${n} stone_sword 1`); consoleCmd(`give ${n} cooked_beef 8`); consoleCmd(`item replace entity ${n} armor.chest with iron_chestplate`); consoleCmd(`give ${n} cobblestone 192`); consoleCmd(`give ${n} oak_planks 128`); consoleCmd(`give ${n} white_bed 1`); }
  await sleep(1500);
  A.agent.run(); B.agent.run(); await sleep(2000);
  w.chat("Beta build a small cobblestone hut here");
  await waitUntil(() => B.agent.goal?.type === "build" && B.agent.goal?.spec && B.agent.current?.name === "build_structure", 120000, 500);
  const sid = B.agent.goal?.sid; await sleep(6000);
  console.log("Beta is building", B.agent.goal?.request, sid);
  w.chat("Alpha stay"); await sleep(1500); consoleCmd(`tp Alpha ${X - 30} ${Y} ${Z}`); await sleep(1500);
  for (let i = 0; i < 2; i++) consoleCmd(`summon zombie ${X - 27 + i} ${Y} ${Z + i}`);
  const went = await waitUntil(() => String(B.agent.goal?.autoKey || "").startsWith("ally:"), 30000, 300);
  const zombies = () => Object.values(A.bot.entities).filter((e) => e.name === "zombie" && e.position.distanceTo(A.bot.entity.position) < 40).length;
  const cleared = await waitUntil(() => zombies() === 0, 90000, 500);
  const back = await waitUntil(() => B.agent.goal?.type === "build" && B.agent.goal?.sid === sid, 90000, 500);
  console.log(`Beta went to help: ${went} | zombies cleared: ${cleared} | back on the same build: ${back}`);
  w.chat("Beta finish it with Alpha"); await sleep(4000);
  const lead = B.agent.goal?.type === "build" && A.agent.goal?.type === "assist" && A.agent.goal?.owner === "Beta";
  console.log(`"Beta finish it with Alpha": Beta ${B.agent.goal?.type} | Alpha ${A.agent.goal?.type} owner ${A.agent.goal?.owner}`);
  const pass = went && cleared && back && lead;
  console.log(pass ? "PASS help call keeps the job, the named one leads" : "FAIL");
  consoleCmd("forceload remove all"); A.agent.stop(); B.agent.stop(); A.bot.quit(); B.bot.quit(); w.quit(); process.exit(pass ? 0 : 1);
})();
