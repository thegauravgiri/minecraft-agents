// Spatial awareness end to end: the bot must find the river the player is facing and bridge it THERE, and build a house
// exactly where the player stands / looks.   node test/e2e/spatial.js bridge|here|facing   (GM=creative for creative mode)
const mineflayer = require("mineflayer");
const { Vec3 } = require("vec3");
const { connect, consoleCmd, botCmd, sleep, waitUntil, settle } = require("./harness");
const what = process.argv[2] || "bridge";
const GM = process.env.GM || "survival";
(async () => {
  const { bot, agent } = await connect("SpatialBot");
  const s = mineflayer.createBot({ host: "localhost", port: 25599, username: "Steve", auth: "offline", version: "26.1.2" });
  await new Promise((r) => s.once("spawn", r)); consoleCmd("op Steve"); consoleCmd("difficulty peaceful"); consoleCmd("time set day");
  consoleCmd("gamemode creative Steve");
  consoleCmd("forceload add 280 270 360 350"); await sleep(1500);
  // world: stone base, grass top at y=199, a 5-wide river (x 318..322) running along z, a pond far to the south as a decoy
  const F = (x1, y1, z1, x2, y2, z2, b) => consoleCmd(`fill ${x1} ${y1} ${z1} ${x2} ${y2} ${z2} ${b}`);
  F(285, 190, 275, 355, 198, 345, "stone"); F(285, 199, 275, 355, 199, 345, "grass_block");
  for (let y = 200; y <= 216; y += 6) F(285, y, 275, 355, Math.min(y + 5, 216), 345, "air");
  F(318, 199, 275, 322, 199, 345, "water");
  F(300, 199, 335, 306, 199, 341, "water");                                        // decoy pond
  await waitUntil(() => bot.blockAt(new Vec3(320, 199, 300))?.name === "water" && bot.blockAt(new Vec3(310, 200, 310))?.name === "air", 20000, 300);
  consoleCmd("tp SpatialBot 300 200 305");
  const SX = what === "facing" ? 304 : what === "facingwet" ? 312 : 312; consoleCmd(`tp Steve ${SX} 200 310`); await sleep(1500);
  consoleCmd(`gamemode ${GM} SpatialBot`);
  await botCmd(bot, "clear @s");
  if (GM !== "creative") for (const [it, n] of [["oak_planks", 192], ["oak_fence", 64], ["cobblestone", 192], ["oak_log", 32], ["glass_pane", 24], ["oak_door", 2], ["torch", 12], ["oak_stairs", 16], ["dirt", 32]]) await botCmd(bot, `give @s ${it} ${n}`);
  await settle(bot);
  console.log("inventory:", JSON.stringify(Object.fromEntries(bot.inventory.items().map((i) => [i.name, i.count]))));
  // Steve looks east (towards the river)
  await s.look(-Math.PI / 2, 0, true); await sleep(800);
  agent.run();
  const said = []; s.on("chat", (u, m) => { if (u === "SpatialBot") said.push(m); });
  const ask = { bridge: "SpatialBot build a bridge across the river", here: "SpatialBot build a small wooden cabin right where I am standing", facingwet: "SpatialBot build a small wooden cabin in front of me", facing: "SpatialBot build a small wooden cabin in front of me" }[what];
  s.chat(ask);
  const t0 = Date.now();
  await waitUntil(() => agent.goal && (agent.goal.type === "bridge" || agent.goal.type === "build"), 60000, 300);
  const gid = agent.goal?.sid;
  console.log("goal:", JSON.stringify({ type: agent.goal?.type, where: agent.goal?.where, anchor: agent.goal?.anchor }));
  await waitUntil(() => !agent.goal || (agent.goal.type !== "bridge" && agent.goal.type !== "build"), 540000, 1000);
  console.log("finished in", Math.round((Date.now() - t0) / 1000) + "s; said:", JSON.stringify(said.filter((m) => m.length < 140).slice(0, 6)));
  const rec = agent.mem.recall(`structure:${gid}`);
  const at = (x, y, z) => bot.blockAt(new Vec3(x, y, z))?.name;
  let pass = false;
  if (what === "bridge") {
    const row = []; for (let x = 316; x <= 324; x++) row.push(`${x}:${at(x, 199, 310)}`);
    console.log("deck row z=310:", row.join(" "), "| origin", JSON.stringify(rec?.origin));
    pass = [318, 319, 320, 321, 322].every((x) => /planks|cobblestone|stone/.test(at(x, 199, 310) || "") && /planks|cobblestone|stone/.test(at(x, 199, 309) || at(x, 199, 311) || ""));
    const decoy = at(303, 199, 338) === "water" && at(303, 200, 338) === "air";
    console.log("decoy pond untouched:", decoy); pass = pass && decoy;
  } else {
    const o = rec?.origin; const sp = agent.goal ? null : null;
    console.log("origin", JSON.stringify(o));
    if (o) {
      const w = 7;                                                                 // cabin footprint is small: centre must be near the target spot
      const cx = o.x + w / 2, cz = o.z + w / 2;
      if (what === "here") pass = Math.hypot(cx - 312, cz - 310) <= 4.5;
      else pass = cx > SX + 1 && cx < SX + 12 && Math.abs(cz - 310) <= 5 && !(SX >= o.x - 1 && SX <= o.x + 8 && 310 >= o.z - 1 && 310 <= o.z + 8);
    }
  }
  console.log(pass ? `PASS spatial ${what}` : `FAIL spatial ${what}`);
  agent.stop(); bot.quit(); s.quit(); process.exit(pass ? 0 : 1);
})();
