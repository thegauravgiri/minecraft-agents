// E2E harness: spawns the agent against the local 26.1.2 test server and drives scenarios via the console fifo.
process.env.BOT_DATA_DIR = require("path").join(require("os").tmpdir(), "mcbot-test-data"); // never touch the real bot memory
process.env.MC_SHARED_DIR ||= require("path").join(require("os").tmpdir(), "mcbot-test-shared-" + process.pid);   // ...nor the real team board (a test bot once joined the live village project)
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createAgentBot } = require("../../src/index");

const FIFO = path.join(process.env.MC_TEST_SERVER_DIR || path.join(os.homedir(), "mc-testserver"), "cmd.fifo");
const PORT = Number(process.env.MC_TEST_PORT || 25599);

function consoleCmd(cmd) { fs.writeFileSync(FIFO, cmd + "\n", { flag: "a" }); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connect(name = "AIBot") {
  const ctx = createAgentBot({ port: PORT, username: name, auto: false });
  await ctx.ready;
  consoleCmd(`op ${name}`);
  await sleep(800);
  return ctx;
}
// Setup commands go straight to the server console (no chat rate-limit, no fixed sleeps).
const botCmd = async (bot, c) => { consoleCmd(c.replace(/^\//, "").replace(/@s\b/g, bot.username).replace(/^gamemode (\w+)$/, `gamemode $1 ${bot.username}`)); await sleep(120); };
// Wait until the bot has landed and the chunks around it are loaded (instead of a blind sleep after /tp).
async function settle(bot, max = 6000) {
  const t0 = Date.now(); let still = 0, lastY = null;
  while (Date.now() - t0 < max) {
    const y = bot.entity.position.y;
    still = bot.entity.onGround && lastY !== null && Math.abs(y - lastY) < 0.01 ? still + 1 : 0;
    lastY = y;
    if (still >= 4 && bot.blockAt(bot.entity.position.offset(0, -1, 0))) return;
    await sleep(100);
  }
}

async function waitUntil(fn, timeout, every = 500) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) { if (await fn()) return true; await sleep(every); }
  return false;
}

module.exports = { connect, consoleCmd, botCmd, sleep, waitUntil, settle };
