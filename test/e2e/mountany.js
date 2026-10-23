// Generic mount / dismount: boat, minecart (and the ghast above).
process.env.MC_AUTONOMY = "off";
const { connect, consoleCmd, sleep, settle } = require("./harness");
(async () => {
  const { bot, agent } = await connect("RideBot");
  consoleCmd("difficulty peaceful"); consoleCmd("time set day");
  const X = 2500, Z = 2500, Y = 150;
  consoleCmd(`forceload add ${X - 20} ${Z - 20} ${X + 20} ${Z + 20}`); await sleep(1500);
  consoleCmd(`fill ${X - 15} ${Y - 5} ${Z - 15} ${X + 15} ${Y - 2} ${Z + 15} stone`); consoleCmd(`fill ${X - 15} ${Y - 1} ${Z - 15} ${X + 15} ${Y - 1} ${Z + 15} grass_block`); consoleCmd(`fill ${X - 15} ${Y} ${Z - 15} ${X + 15} ${Y + 9} ${Z + 15} air`);
  await sleep(2500);
  consoleCmd("kill @e[type=minecraft:oak_boat]"); consoleCmd("kill @e[type=minecraft:minecart]");
  consoleCmd(`tp RideBot ${X} ${Y} ${Z}`); consoleCmd("gamemode survival RideBot"); await sleep(2000); await settle(bot);
  consoleCmd(`summon oak_boat ${X + 5} ${Y} ${Z}`); consoleCmd(`summon minecart ${X - 5} ${Y} ${Z}`); await sleep(2000);
  const res = {};
  for (const [name, target] of [["boat", "boat"], ["minecart", "minecart"]]) {
    const m = await agent.exec({ skill: "mount_ride", args: { target } }, false);
    res[name + " mount"] = m.ok && /boat|minecart/.test(bot.vehicle?.name || "");
    const d = await agent.exec({ skill: "dismount_ride", args: {} }, false);
    res[name + " dismount"] = d.ok && !bot.vehicle;
    await sleep(500);
  }
  console.log(JSON.stringify(res));
  const pass = Object.values(res).every(Boolean);
  console.log(pass ? "PASS mount/dismount boat + minecart" : "FAIL");
  agent.stop(); bot.quit(); process.exit(pass ? 0 : 1);
})();
