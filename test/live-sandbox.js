// Non-destructive, runs in the REAL world (MC_PORT, default 44444): bad coordinates must fail fast with a repairable error.
const { createAgentBot } = require("../src/index");
const { runScript } = require("../src/brain/sandbox");
const { goto } = require("../src/skills/move");
(async () => {
  const { bot, agent, reg } = await (async () => { const o = createAgentBot({ port: Number(process.env.MC_PORT || 44444), username: "SbxBot", auto: false, chat: false }); await o.ready; return o; })();
  const ctx = { bot, reg, mem: agent.mem, agent, signal: new AbortController().signal };
  let t = Date.now();
  let r = await runScript(ctx, `await api.goto(27.5, 62, NaN);`);
  console.log("NaN goto:", !r.ok && /finite number/.test(r.error) ? "PASS (fails fast, clear error)" : "FAIL " + JSON.stringify(r), `${Date.now() - t}ms`, "|", r.error);
  t = Date.now(); r = await goto(ctx, { x: NaN, y: 1, z: 1, isEnd: () => false }, { towardPos: { x: 1, y: 1, z: NaN } });
  console.log("goto(NaN):", r.reason === "invalid_target" ? "PASS" : "FAIL " + JSON.stringify(r), `${Date.now() - t}ms`);
  t = Date.now(); r = await runScript(ctx, `return api.pos().y > -100 && api.count("dirt") >= 0;`);
  console.log("normal script:", r.ok ? "PASS" : "FAIL " + r.error, `${Date.now() - t}ms`);
  bot.quit(); process.exit(0);
})();
