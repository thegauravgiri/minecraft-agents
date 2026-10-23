// "Flatten this hill": one fill script, not 80 digs. Also: the fill must refuse to touch a remembered house.
const mineflayer = require("mineflayer");
const { Vec3 } = require("vec3");
const { connect, consoleCmd, botCmd, sleep, waitUntil, settle } = require("./harness");
const { fillBox } = require("../../src/skills/commands");
(async () => {
  const { bot, agent, reg } = await connect("FlatBot");
  agent.mem.remember("house", null);
  const s = mineflayer.createBot({ host: "localhost", port: 25599, username: "Steve", auth: "offline", version: "26.1.2" });
  await new Promise((r) => s.once("spawn", r)); consoleCmd("op Steve");
  consoleCmd("difficulty peaceful"); consoleCmd("time set day"); consoleCmd("gamemode survival FlatBot");
  await settle(bot);
  const P = bot.entity.position.floored(); const X = P.x, Z = P.z, Y = P.y;
  consoleCmd(`fill ${X - 30} ${Y - 30} ${Z - 30} ${X + 30} ${Y - 2} ${Z + 30} stone`); consoleCmd(`fill ${X - 30} ${Y - 1} ${Z - 30} ${X + 30} ${Y - 1} ${Z + 30} grass_block`); consoleCmd(`fill ${X - 30} ${Y} ${Z - 30} ${X + 30} ${Y + 30} ${Z + 30} air`);
  consoleCmd(`fill ${X + 6} ${Y} ${Z - 8} ${X + 24} ${Y + 14} ${Z + 8} stone`);                  // the hill: 19 x 15 x 17
  await waitUntil(() => bot.blockAt(new Vec3(X + 12, Y + 10, Z))?.name === "stone", 20000, 300);
  consoleCmd(`tp FlatBot ${X} ${Y} ${Z}`); await settle(bot); consoleCmd("gamemode creative FlatBot"); await sleep(1200);
  const hill = () => { let n = 0; for (let x = X + 6; x <= X + 24; x += 3) for (let y = Y; y <= Y + 14; y += 2) for (let z = Z - 8; z <= Z + 8; z += 3) if (bot.blockAt(new Vec3(x, y, z))?.name === "stone") n++; return n; };
  console.log("hill samples before:", hill());
  // 1) safeguard: a remembered house overlapping the area blocks the fill
  const ctx = { bot, reg, mem: agent.mem, agent, signal: new AbortController().signal };
  agent.mem.remember("house", { origin: { x: X + 10, y: Y, z: Z }, size: { w: 5, d: 5, h: 4 } });
  const refused = await fillBox(ctx, X + 6, Y, Z - 8, X + 24, Y + 14, Z + 8, "air");
  console.log("fill near a remembered house ->", refused.ok ? "ALLOWED (bad)" : `refused (${refused.reason})`);
  agent.mem.remember("house", null);   // clears the persisted fact too (otherwise the next run starts with a protected area)
  // 2) the real request through chat + the AI
  agent.run();
  const t0 = Date.now();
  s.chat(`FlatBot flatten the hill in front of you (x ${X + 6} to ${X + 24}, z ${Z - 8} to ${Z + 8}, y ${Y} to ${Y + 14}) down to ground level`);
  const ok = await waitUntil(() => hill() === 0, 120000, 1000);
  console.log(ok ? "PASS" : "FAIL", `hill flattened in ${((Date.now() - t0) / 1000).toFixed(0)}s | hill samples after: ${hill()} | refused protected fill: ${!refused.ok && refused.reason === "protected_area"}`);
  agent.stop(); bot.quit(); s.quit(); process.exit(ok && refused.reason === "protected_area" ? 0 : 1);
})();
