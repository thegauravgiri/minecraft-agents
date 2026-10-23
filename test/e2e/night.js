// Night: even a geared bot with no bed digs in (no fighting the night), and a creeper is avoided, never hit.
process.env.MC_BANTER = "off";
const { Vec3 } = require("vec3");
const { connect, consoleCmd, sleep, waitUntil, settle } = require("./harness");
(async () => {
  const { bot, agent } = await connect("NightBot");
  const X = 3100, Z = 3100, Y = 150;
  consoleCmd(`forceload add ${X - 20} ${Z - 20} ${X + 20} ${Z + 20}`); await sleep(1500);
  consoleCmd(`fill ${X - 15} ${Y - 8} ${Z - 15} ${X + 15} ${Y - 2} ${Z + 15} dirt`); consoleCmd(`fill ${X - 15} ${Y - 1} ${Z - 15} ${X + 15} ${Y - 1} ${Z + 15} grass_block`); consoleCmd(`fill ${X - 15} ${Y} ${Z - 15} ${X + 15} ${Y + 8} ${Z + 15} air`);
  await sleep(2500);
  consoleCmd("difficulty normal"); consoleCmd("gamerule doMobSpawning false"); consoleCmd("gamerule doDaylightCycle false"); consoleCmd("time set 14000");
  consoleCmd(`tp NightBot ${X} ${Y} ${Z}`); consoleCmd("gamemode survival NightBot"); consoleCmd("clear NightBot");
  for (const it of ["iron_sword", "stone_pickaxe", "stone_axe", "cooked_beef 10", "dirt 32"]) consoleCmd(`give NightBot ${it}`);
  consoleCmd("item replace entity NightBot armor.chest with iron_chestplate"); consoleCmd("item replace entity NightBot armor.head with iron_helmet");
  await sleep(2500); await settle(bot);
  agent.run();
  const hid = await waitUntil(() => agent.goal?.type === "hideout" || agent.current?.name === "burrow", 40000, 300);
  console.log("dug in at night:", hid, "| goal", agent.goal?.type);
  await sleep(8000);
  const inPit = bot.entity.position.y < Y - 1.5;
  console.log("in the pit:", inPit, "y", bot.entity.position.y.toFixed(1));
  consoleCmd("time set day"); await sleep(15000);
  const out = bot.entity.position.y >= Y - 0.6;
  console.log("out in the morning:", out, "y", bot.entity.position.y.toFixed(1));
  // creeper: never melee it
  let hitCreeper = false; bot.on("entitySwingArm", () => {}); const origAttack = bot.attack.bind(bot); bot.attack = (e, ...r) => { if (e?.name === "creeper") hitCreeper = true; return origAttack(e, ...r); };
  consoleCmd("time set 14000"); agent.autonomy.pause(60000);
  consoleCmd(`summon creeper ${Math.floor(bot.entity.position.x) + 6} ${Y} ${Math.floor(bot.entity.position.z)}`);
  await sleep(9000);
  console.log("hit the creeper:", hitCreeper, "| hp", Math.round(bot.health));
  const pass = hid && inPit && out && !hitCreeper;
  console.log(pass ? "PASS night instinct" : "FAIL");
  consoleCmd("kill @e[type=creeper]"); consoleCmd("gamerule doDaylightCycle true"); consoleCmd("gamerule doMobSpawning true"); consoleCmd("difficulty peaceful"); consoleCmd("time set day");
  agent.stop(); bot.quit(); process.exit(pass ? 0 : 1);
})();
