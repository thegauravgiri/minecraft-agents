// Entry point: connect, build the agent, route chat -> goals.
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });
const mineflayer = require("mineflayer");
const { pathfinder } = require("mineflayer-pathfinder");
const { makeRegistry } = require("./core/registry");
const { Agent } = require("./runtime/agent");
const { handleChat } = require("./brain/chat");
const { Brain } = require("./brain/llm");
const { installDigTime } = require("./runtime/dig-time");
const { log } = require("./runtime/util");

function createAgentBot({ host = "localhost", port, username = "Vesper", version = "26.1.2", auto = true, chat = true, gamemode = null } = {}) {
  const bot = mineflayer.createBot({ host, port, username, auth: "offline", version });
  bot.loadPlugin(pathfinder);
  require("./runtime/world").capture(bot);
  const out = { bot, agent: null, reg: null };
  out.ready = new Promise((resolve, reject) => {
    bot.once("spawn", () => {
    // one outgoing-chat queue (servers kick for spam); commands and speech share it
    const rawChat = bot.chat.bind(bot);
    const queue = [];
    let draining = false;
    // Minecraft cuts chat at 256 characters: a longer message is sent as several lines, split at sentence/word boundaries (never mid-word)
    const split = (m) => {
      m = String(m);
      if (m.length <= 240 || m.startsWith("/")) return [m];
      const out = []; let rest = m;
      while (rest.length > 240 && out.length < 3) {
        let cut = Math.max(rest.lastIndexOf(". ", 235), rest.lastIndexOf("! ", 235), rest.lastIndexOf("? ", 235), rest.lastIndexOf(", ", 235), rest.lastIndexOf(" ", 235));
        if (cut < 120) cut = 235;
        out.push(rest.slice(0, cut + 1).trim()); rest = rest.slice(cut + 1).trim();
      }
      if (rest) out.push(rest.slice(0, 240));
      return out;
    };
    const chatOne = (m) => {
      // overflow policy: thought whispers (/msg) go first, real replies and commands are kept
    if (queue.length > 8) { const i = queue.findIndex((q) => String(q).startsWith("/msg ")); queue.splice(i >= 0 ? i : 0, 1); }
      queue.push(m);
      if (draining) return;
      draining = true;
      (async function drain() {
        while (queue.length) { rawChat(queue.shift()); await new Promise((r) => setTimeout(r, 1200)); }
        draining = false;
      })();
    };
    bot.chat = (m) => { for (const part of split(m)) chatOne(part); };
      // mineflayer only ever APPENDS to a vehicle's passenger list: when the bot gets off a ghast that still carries somebody else, bot.vehicle stayed set
      // (we then "could not dismount" forever). The server's list is authoritative.
      bot._client.on("set_passengers", ({ entityId, passengers }) => {
        const v = bot.entities[entityId]; if (!v) return;
        v.passengers = passengers.map((id) => bot.entities[id]).filter(Boolean);
        for (const e of Object.values(bot.entities)) if (e.vehicle === v && !passengers.includes(e.id)) e.vehicle = null;
        if (bot.vehicle === v && !passengers.includes(bot.entity.id)) { bot.vehicle = null; bot.emit("dismount", v); }
      });
      bot.pathfinder.searchRadius = 160;      // an unreachable goal in open terrain must not make A* eat the heap (an agent died of that)
      bot.pathfinder.thinkTimeout = 4000;
      out.reg = makeRegistry(bot.registry.version?.minecraftVersion || "26.1");
      installDigTime(bot, out.reg);
      // put the agent in the game mode it is meant to play in (needs cheats/op: harmless no-op message otherwise)
      if (gamemode && bot.game?.gameMode !== gamemode) { log("boot", `switching ${username} to ${gamemode} mode`); bot.chat(`/gamemode ${gamemode} ${bot.username}`); }
      require("./runtime/world").reconcile(bot, username);        // new world => clean memory, before anything loads its saved state
      const brain = new Brain();                    // provider, key and models from .env (AI_PROVIDER / AI_MODEL / ..., see src/brain/providers.js)
      out.agent = new Agent(bot, out.reg, { say: (m) => bot.chat(String(m)), advisor: brain.available ? brain : null });
      out.agent.brain = brain;
      log("boot", `AI ${brain.label}${brain.provider ? "" : " - local intent only"}`);
      if (auto) out.agent.run();
      if (chat) bot.on("chat", (u, m) => { if (u !== bot.username && bot.players[u]) handleChat(out.agent, u, m).catch((e) => log("chat", e.stack)); });
      if (chat) bot.on("whisper", (u, m) => { if (u !== bot.username && bot.players[u]) handleChat(out.agent, u, m, { whisper: true }).catch((e) => log("chat", e.stack)); });
      log("boot", `${username} ready on ${bot.game.dimension} at ${bot.entity.position}`);
      resolve(out);
    });
    bot.once("error", reject);
  });
  bot.on("kicked", (r) => log("boot", "kicked:", JSON.stringify(r)));
  bot.on("error", (e) => log("boot", "error:", e.message));
  out.ended = new Promise((resolve) => bot.once("end", (r) => { log("boot", "disconnected:", r); resolve(r); }));
  return out;
}

// Run forever: if the server kicks us or restarts, reconnect with backoff and carry on.
// A late failure from an abandoned sandbox script (or any stray promise) must never take the whole bot out of the world.
process.on("unhandledRejection", (e) => console.log("[boot] unhandled rejection ignored:", String(e?.stack || e).split("\n").slice(0, 3).join(" | ")));
process.on("uncaughtException", (e) => console.log("[boot] uncaught exception ignored:", String(e?.stack || e).split("\n").slice(0, 3).join(" | ")));

// Unattended-run safety: report the heap now and then, and restart cleanly (exit 75 -> the supervisor relaunches) long before V8 dies.
function watchMemory() {
  const MB = 1048576; let last = 0;
  const iv = setInterval(() => {
    const m = process.memoryUsage(), heap = Math.round(m.heapUsed / MB);
    if (Date.now() - last > 300000) { last = Date.now(); log("mem", `heap ${heap} MB, rss ${Math.round(m.rss / MB)} MB`); }
    if (heap > (parseInt(process.env.MC_MAX_HEAP_MB || "1400", 10))) { log("mem", `heap ${heap} MB is too high - restarting cleanly`); process.exit(75); }
  }, 30000);
  iv.unref?.();
}

async function main() {
  watchMemory();
  const port = parseInt(process.argv[2] || process.env.MC_PORT || "0", 10);        // command line wins over .env
  const username = process.argv[3] || process.env.MC_BOT_NAME || "Vesper";
  const host = process.argv[4] || process.env.MC_HOST || "localhost";
  if (!port) { console.log("Usage: node bot.js <PORT> [BOT_NAME] [HOST]   (or set MC_PORT in .env)"); process.exit(1); }
  if (!process.env.BOT_DATA_DIR) process.env.BOT_DATA_DIR = path.resolve(__dirname, "..", "data", username);   // every agent has its own memory: data/<name>
  let delay = 3000;
  for (;;) {
    log("boot", `connecting ${username} to ${host}:${port} ...`);
    const inst = createAgentBot({ host, port, username, gamemode: (process.env.MC_BOT_GAMEMODE || "keep").toLowerCase() === "keep" ? null : (process.env.MC_BOT_GAMEMODE || "keep").toLowerCase() });
    let up = false;
    inst.ready.then(() => { up = true; delay = 3000; }).catch((e) => log("boot", "connect failed:", e.message));
    await Promise.race([inst.ended, inst.ready.then(() => inst.ended).catch(() => null)]);
    try { inst.agent?.stop(); inst.agent?.director?.cancel("disconnect"); } catch { /* already gone */ }
    log("boot", `reconnecting in ${Math.round(delay / 1000)}s`);
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay * 2, 60000);
  }
}

if (require.main === module) main();

module.exports = { createAgentBot, main };
