// Happy ghast: the bot gets a harness on it, takes the driver seat, flies it (a human rides along), lands and gets off.
process.env.MC_AUTONOMY = "off";
const mineflayer = require("mineflayer");
const { Vec3 } = require("vec3");
const { connect, consoleCmd, sleep, waitUntil, settle } = require("./harness");
(async () => {
  const { bot, agent } = await connect("GhastBot");
  const s = mineflayer.createBot({ host: "localhost", port: 25599, username: "Steve", auth: "offline", version: "26.1.2" });
  await new Promise((r) => s.once("spawn", r)); consoleCmd("op Steve"); consoleCmd("gamemode creative Steve"); consoleCmd("difficulty peaceful"); consoleCmd("time set day");
  const X = 2100, Z = 2100, Y = 150;
  consoleCmd(`forceload add ${X - 90} ${Z - 30} ${X + 90} ${Z + 30}`); await sleep(2500);
  for (let x = X - 90; x <= X + 90; x += 30) { consoleCmd(`fill ${x} ${Y - 5} ${Z - 30} ${x + 29} ${Y - 2} ${Z + 30} stone`); consoleCmd(`fill ${x} ${Y - 1} ${Z - 30} ${x + 29} ${Y - 1} ${Z + 30} grass_block`); consoleCmd(`fill ${x} ${Y} ${Z - 30} ${x + 29} ${Y + 30} ${Z + 30} air`); }
  consoleCmd(`fill ${X + 40} ${Y} ${Z - 3} ${X + 40} ${Y + 12} ${Z + 3} stone`);          // a wall to fly over on the way
  await sleep(6000);
  consoleCmd("kill @e[type=happy_ghast]");
  consoleCmd(`tp GhastBot ${X} ${Y} ${Z}`); consoleCmd("gamemode survival GhastBot"); consoleCmd("clear GhastBot"); consoleCmd("give GhastBot white_harness 1"); consoleCmd(`tp Steve ${X + 2} ${Y} ${Z + 3}`);
  consoleCmd(`summon happy_ghast ${X + 4} ${Y + 1} ${Z} {Age:0}`); await sleep(3000); await settle(bot);

  // 1) mount (harness comes with the job), 2) Steve gets on as a passenger, 3) fly 80 blocks east over the wall, land, get off
  let r = await agent.exec({ skill: "mount_ride", args: { target: "happy_ghast" } }, false);
  console.log("mount:", JSON.stringify(r).slice(0, 140), "| driver seat:", (bot.vehicle?.passengers || [])[0] === bot.entity);
  const g = bot.vehicle;
  await s.lookAt(g.position.offset(0, 2, 0), true); await s.activateEntity(g); await sleep(1500);
  console.log("Steve riding:", !!s.vehicle && s.vehicle.name);
  const tx = X + 80;
  r = await agent.exec({ skill: "drive_ghast", args: { pos: { x: tx, y: Y, z: Z }, land: true } }, false);
  await sleep(800);
  const me = bot.entity.position, st = s.entity.position;
  console.log("drive:", JSON.stringify(r).slice(0, 140), "| bot at", me.toString(), "| Steve at", st.toString(), "| bot mounted:", !!bot.vehicle);
  const ok1 = r.ok && Math.hypot(me.x - tx, me.z - Z) < 8 && me.y < Y + 2.5 && !bot.vehicle && Math.hypot((s.vehicle ? s.vehicle.position.x : st.x) - tx, Z - Z) < 10;
  console.log(ok1 ? "PASS drives the ghast, lands, gets off - passenger arrives too" : "FAIL");
  agent.stop(); bot.quit(); s.quit(); process.exit(ok1 ? 0 : 1);
})();
