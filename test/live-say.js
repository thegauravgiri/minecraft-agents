// Non-destructive live check in the REAL world (port MC_PORT): a helper player only TALKS to the bot and watches.
// Usage: node test/live-say.js "<message to Vesper>" [watchSeconds]
const mineflayer = require("mineflayer");
const msg = process.argv[2] || "sleep";
const watch = parseInt(process.argv[3] || "60", 10) * 1000;
const h = mineflayer.createBot({ host: "localhost", port: Number(process.env.MC_PORT || 44444), username: "TestHelper", auth: "offline", version: "26.1.2" });
h.once("spawn", () => {
  console.log("helper in world; Vesper present:", !!h.players.Vesper);
  const t0 = Date.now();
  h.on("messagestr", (m) => { if (/Vesper/.test(m)) console.log(`+${((Date.now() - t0) / 1000).toFixed(1)}s`, m.slice(0, 160)); });
  setTimeout(() => { h.chat(`Vesper ${msg}`); }, 1500);
  setTimeout(() => { console.log("done watching"); h.quit(); process.exit(0); }, watch);
});
h.on("kicked", (r) => { console.log("kicked", JSON.stringify(r)); process.exit(1); });
h.on("error", (e) => { console.log("error", e.message); process.exit(1); });
