// A multi-step request must produce exactly ONE "anything else?" - at the very end.
const mineflayer = require("mineflayer");
const { connect, consoleCmd, botCmd, sleep, waitUntil, settle } = require("./harness");
(async () => {
  const { bot, agent } = await connect("AskBot");
  const asker = await new Promise((r) => { const b = mineflayer.createBot({ host: "localhost", port: 25599, username: "Gems", auth: "offline", version: "26.1.2" }); b.once("spawn", () => r(b)); });
  consoleCmd("op Gems"); consoleCmd("difficulty peaceful"); consoleCmd("gamemode survival AskBot"); consoleCmd("tp AskBot 150 90 -150"); await settle(bot);
  await botCmd(bot, "clear @s"); await botCmd(bot, "give @s oak_log 8"); consoleCmd("tp Gems AskBot"); await sleep(1200);
  const said = []; asker.on("chat", (u, m) => { if (u === "AskBot") said.push(m); });
  agent.run();
  asker.chat("AskBot craft 8 oak planks and then craft 4 sticks and then craft a crafting table");
  await waitUntil(() => said.some((m) => /anything else/i.test(m)), 90000, 300);
  await sleep(1500);
  const asks = said.filter((m) => /anything else|what would you|what should/i.test(m)).length;
  console.log("public messages:\n  " + said.join("\n  "));
  console.log(asks === 1 ? "PASS asked exactly once (at the end)" : `FAIL asked ${asks} times`);
  agent.stop(); bot.quit(); asker.quit(); process.exit(asks === 1 ? 0 : 1);
})();
