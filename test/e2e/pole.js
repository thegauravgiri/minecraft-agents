// Creative: a tall 1x1 pole with a cloth hanging off it (no support below the cloth).
process.env.MC_AUTONOMY = "off"; process.env.MC_BANTER = "off";
const { Vec3 } = require("vec3");
const { connect, consoleCmd, sleep, settle } = require("./harness");
(async () => {
  const { bot, agent } = await connect("PoleBot");
  const X = 4100, Z = 4100, Y = 150;
  consoleCmd(`forceload add ${X - 20} ${Z - 20} ${X + 20} ${Z + 20}`); await sleep(2000);
  consoleCmd(`fill ${X - 15} ${Y - 5} ${Z - 15} ${X + 15} ${Y - 2} ${Z + 15} dirt`); consoleCmd(`fill ${X - 15} ${Y - 1} ${Z - 15} ${X + 15} ${Y - 1} ${Z + 15} grass_block`); consoleCmd(`fill ${X - 15} ${Y} ${Z - 15} ${X + 15} ${Y + 30} ${Z + 15} air`);
  await sleep(3000);
  consoleCmd(`tp PoleBot ${X - 6} ${Y} ${Z}`); consoleCmd("gamemode creative PoleBot"); await sleep(2500); await settle(bot);
  const spec = { name: "pole flag", size: { w: 8, d: 1, h: 20 }, palette: { p: "stone_bricks", r: "red_wool", b: "blue_wool" },
    ops: [{ op: "box", from: [0, 0, 0], to: [0, 19, 0], block: "p" }, { op: "box", from: [1, 12, 0], to: [7, 18, 0], block: "r" }, { op: "box", from: [1, 12, 0], to: [7, 12, 0], block: "b" }] };
  agent.setGoal({ type: "build", request: "pole flag", spec, anchor: { mode: "coords", x: X + 3, y: Y - 1, z: Z } });
  agent.run();
  const t0 = Date.now();
  while (Date.now() - t0 < 150000 && agent.goal) await sleep(2000);
  const at = (x, y, z) => bot.blockAt(new Vec3(x, y, z))?.name;
  const rec = agent.mem.recall(`structure:${agent.lastBuildGoal?.sid || ""}`);
  let pole = 0, cloth = 0; for (let y = Y - 1; y < Y + 25; y++) for (let x = X - 3; x <= X + 12; x++) { const n = at(x, y, Z); if (n === "stone_bricks") pole++; if (/wool/.test(n || "")) cloth++; }
  console.log(`pole blocks ${pole}/20, cloth ${cloth}/49, ${Math.round((Date.now() - t0) / 1000)}s, goal left: ${agent.goal?.type || "none"}`);
  console.log(pole >= 19 && cloth >= 46 ? "PASS pole and hanging cloth" : "FAIL");
  agent.stop(); bot.quit(); process.exit(0);
})();
