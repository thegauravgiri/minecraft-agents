// A village is not a quarry: logs of a frame (no leaves), planks, cobblestone and doors are never mining candidates; a real tree is.
const { Vec3 } = require("vec3");
const { connect, consoleCmd, sleep, waitUntil, settle } = require("./harness");
const { findCandidates } = require("../../src/skills/gather");
(async () => {
  const { bot, agent } = await connect("GuardBot");
  consoleCmd("difficulty peaceful"); consoleCmd("time set day");
  const X = 1700, Z = 1700, Y = 150;
  consoleCmd(`forceload add ${X - 20} ${Z - 20} ${X + 20} ${Z + 20}`); await sleep(1500);
  consoleCmd(`fill ${X - 15} ${Y - 5} ${Z - 15} ${X + 15} ${Y - 2} ${Z + 15} stone`); consoleCmd(`fill ${X - 15} ${Y - 1} ${Z - 15} ${X + 15} ${Y - 1} ${Z + 15} grass_block`); consoleCmd(`fill ${X - 15} ${Y} ${Z - 15} ${X + 15} ${Y + 9} ${Z + 15} air`);
  await sleep(2500);
  consoleCmd(`fill ${X + 2} ${Y} ${Z} ${X + 2} ${Y + 3} ${Z} oak_log`);                      // a house's corner post: no leaves
  consoleCmd(`fill ${X + 4} ${Y} ${Z} ${X + 6} ${Y + 2} ${Z} cobblestone`); consoleCmd(`fill ${X + 4} ${Y} ${Z + 2} ${X + 6} ${Y} ${Z + 2} oak_planks`);
  consoleCmd(`fill ${X - 6} ${Y} ${Z} ${X - 6} ${Y + 3} ${Z} oak_log`); consoleCmd(`fill ${X - 7} ${Y + 3} ${Z - 1} ${X - 5} ${Y + 4} ${Z + 1} oak_leaves`);   // a tree: trunk + canopy
  await sleep(1500);
  consoleCmd(`tp GuardBot ${X} ${Y} ${Z + 4}`); consoleCmd("gamemode survival GuardBot"); await sleep(2500); await settle(bot);
  const logs = findCandidates({ bot, mem: agent.mem }, ["oak_log"], { maxDistance: 20 }).map((c) => `${c.pos.x - X},${c.pos.z - Z}`);
  const stone = findCandidates({ bot, mem: agent.mem }, ["cobblestone", "oak_planks"], { maxDistance: 20 });
  const onlyTree = logs.length > 0 && logs.every((p) => p.startsWith("-6,"));
  console.log("log candidates (x,z rel):", logs.join(" | "), "| cobble/planks candidates:", stone.length);
  const ok = onlyTree && stone.length === 0;
  console.log(ok ? "PASS village blocks are protected, trees are not" : "FAIL");
  agent.stop(); bot.quit(); process.exit(ok ? 0 : 1);
})();
