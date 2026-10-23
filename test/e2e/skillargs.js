// A script reads its parameters from api.args; unknown api calls are rejected before anything runs.
const { connect } = require("./harness");
const { runScript } = require("../../src/brain/sandbox");
(async () => {
  const { agent, bot } = await connect("ArgsBot");
  const ctx = { bot, reg: agent.reg, mem: agent.mem, agent, signal: new AbortController().signal, beat: () => {} };
  const a = await runScript(ctx, "return api.args.n * 2 + ':' + api.args.who;", { args: { n: 21, who: "Gable" } });
  const b = await runScript(ctx, "await api.teleportHome();", { args: {} });
  const ok = a.ok && a.value === "42:Gable" && !b.ok && /unknown API/.test(b.error);
  console.log(ok ? "PASS api.args works, unknown API rejected up front" : `FAIL ${JSON.stringify(a)} ${JSON.stringify(b)}`);
  agent.stop(); bot.quit(); process.exit(ok ? 0 : 1);
})();
