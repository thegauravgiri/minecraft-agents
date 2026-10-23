// "Day N" episodes - a series format for filming the agents.
//   a player says  "day 4: build the village"   -> the leader puts DAY 4 on everyone's screen, a boss bar with the goal and progress,
//                                                   starts OBS recording (if configured) and turns the goal into team jobs
//   ... the agents play; every highlight (calls for help, rescues, deaths, finished jobs, plans) and every chat line is logged ...
//   a player says  "end of day"                 -> the leader sums the day up in chat, stops recording and writes, in episodes/day-04/:
//        highlights.md   the moments worth cutting to, with their time in the recording
//        captions.srt    the day's chat as subtitles, timed to the recording
//        events.jsonl / chat.jsonl / episode.json   the raw material (for the editor script)
// Every agent process writes to the same files; only the elected leader runs the show.
const fs = require("fs");
const path = require("path");
const { log } = require("../runtime/util");

const sharedDir = () => process.env.MC_SHARED_DIR || path.resolve(__dirname, "..", "..", "data", "shared");
const stateFile = () => path.join(sharedDir(), "episode.json");
const EPISODES = () => process.env.EPISODES_DIR || path.resolve(__dirname, "..", "..", "episodes");
const dirOf = (day) => path.join(EPISODES(), `day-${String(day).padStart(2, "0")}`);
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; } };
function writeJson(f, obj) { fs.mkdirSync(path.dirname(f), { recursive: true }); const t = `${f}.${process.pid}.tmp`; fs.writeFileSync(t, JSON.stringify(obj, null, 2)); fs.renameSync(t, f); }

const START = /^\s*(?:day|episode|ep)\s*#?\s*(\d{1,3})\s*[:\-–,]?\s*(.{3,})$/i;
const END = /^\s*(?:(?:that'?s\s+)?(?:the\s+)?end\s+of\s+(?:the\s+)?day|day\s*\d*\s*(?:is\s+)?(?:over|done|complete|finished)|that'?s\s+a\s+wrap|wrap\s+(?:it\s+)?up)\b/i;

/** The running episode, or null. */
function current() { const s = readJson(stateFile()); return s && !s.endedAt ? s : null; }

function append(file, obj) { try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.appendFileSync(file, JSON.stringify(obj) + "\n"); } catch (e) { log("episode", "write failed: " + e.message); } }

/** A moment worth showing: kind = help | rescue | death | done | plan | milestone | thought | decision | start | end | note. */
function mark(agent, kind, text) {
  const ep = current(); if (!ep) return;
  append(path.join(dirOf(ep.day), "events.jsonl"), { wall: Date.now(), agent, kind, text: String(text).slice(0, 200) });
}
/** A chat line (every process hears every line; duplicates are removed when exporting). */
// server feedback to the leader's own commands ("[Vesper: Changed title display times for 3 players]") is not dialogue
const FEEDBACK = /^[^\[]*\]\s*$|^(Changed title|Showing new (sub)?title|Created custom bossbar|Custom bossbar|Removed custom bossbar|Set the time|Gave \d|Teleported|Unknown or incomplete command)/;
function chatLine(speaker, text) {
  const ep = current(); if (!ep || FEEDBACK.test(String(text))) return;
  append(path.join(dirOf(ep.day), "chat.jsonl"), { wall: Date.now(), speaker, text: String(text).slice(0, 240) });
}

const json = (o) => JSON.stringify(o);
const titleCmds = (day, goal) => [
  `/title @a times 10 70 20`,
  `/title @a subtitle ${json({ text: goal.slice(0, 60), color: "white" })}`,
  `/title @a title ${json({ text: `DAY ${day}`, color: "gold", bold: true })}`,
  `/bossbar remove agents:day`,
  `/bossbar add agents:day ${json({ text: `Day ${day}: ${goal.slice(0, 50)}`, color: "gold" })}`,
  `/bossbar set agents:day color yellow`,
  `/bossbar set agents:day max 100`,
  `/bossbar set agents:day value 0`,
  `/bossbar set agents:day players @a`
];

/** Handles "day N: goal" / "end of day" from a player. Returns true when the message was an episode command (for every agent). */
function onChat(agent, speaker, message) {
  if (agent.isAgent(speaker)) return false;
  const start = String(message).match(START), end = !start && END.test(message);
  if (!start && !end) return false;
  const { electCoordinator, audience } = require("./team-project");
  const leader = electCoordinator(agent, audience(message).named, message) === agent.bot.username;
  if (!leader) { log("episode", `${speaker}: "${message}" - the leader runs the episode`); return true; }
  if (start) startEpisode(agent, speaker, Number(start[1]), start[2].trim().replace(/[.!]+$/, "")).catch((e) => log("episode", "start failed: " + e.stack));
  else endEpisode(agent, speaker).catch((e) => log("episode", "end failed: " + e.stack));
  return true;
}

let progressTimer = null;

async function startEpisode(agent, speaker, day, goal) {
  const prev = current();
  if (prev) await endEpisode(agent, speaker, { quiet: true });
  const state = { day, goal, by: speaker, leader: agent.bot.username, startedAt: Date.now(), recordingStartedAt: null, video: null };
  fs.rmSync(dirOf(day), { recursive: true, force: true });                 // a re-take of the same day starts clean
  writeJson(stateFile(), state);
  writeJson(path.join(dirOf(day), "episode.json"), state);
  log("episode", `DAY ${day}: ${goal} (by ${speaker})`);
  const rec = await require("../runtime/obs").startRecording();
  if (rec) { state.recordingStartedAt = rec; writeJson(stateFile(), state); writeJson(path.join(dirOf(day), "episode.json"), state); }
  for (const c of titleCmds(day, goal)) agent.bot.chat(c);
  mark(agent.bot.username, "start", `Day ${day}: ${goal}`);
  agent.autonomy.resume(); agent.lastHumanCommand = Date.now();
  agent.say(pickLine([`Day ${day}. Today: ${goal}. Let's go team!`, `Alright, day ${day} - ${goal}. Everyone with me?`, `Day ${day} starts now: ${goal}.`]), { noName: true, force: true });
  // the goal becomes the team's project (the leader plans it, the others take the jobs)
  setTimeout(() => agent.projects.onGroupMessage(speaker, `${goal} together`, { force: true }).catch((e) => log("episode", e.message)), 3000);
  clearInterval(progressTimer);
  progressTimer = setInterval(() => updateProgress(agent), 20000);
}

/** Boss bar = share of the day's jobs that are done. */
function updateProgress(agent) {
  const ep = current(); if (!ep || ep.leader !== agent.bot.username) { clearInterval(progressTimer); return; }
  const board = require("../runtime/project");
  const p = board.all().filter((x) => x.created >= ep.startedAt - 5000).sort((a, b) => b.created - a.created)[0];
  if (!p) return;
  const ts = board.tasks(p.id); if (!ts.length) return;
  const pct = Math.round((100 * ts.filter((t) => t.state === "done").length) / ts.length);
  if (pct !== ep.lastPct) { agent.bot.chat(`/bossbar set agents:day value ${pct}`); writeJson(stateFile(), { ...ep, lastPct: pct }); }
}

async function endEpisode(agent, speaker, { quiet = false } = {}) {
  const ep = current(); if (!ep) { if (!quiet) agent.say("There's no day running - start one with \"day 1: <goal>\".", { to: speaker }); return; }
  clearInterval(progressTimer);
  mark(agent.bot.username, "end", `End of day ${ep.day}`);
  if (!quiet) {
    const recap = await recapOf(agent, ep);
    agent.bot.chat(`/title @a subtitle ${json({ text: "see you tomorrow", color: "gray" })}`);
    agent.bot.chat(`/title @a title ${json({ text: `END OF DAY ${ep.day}`, color: "gold", bold: true })}`);
    for (const line of recap) agent.say(line, { noName: true, force: true });
  }
  agent.bot.chat("/bossbar remove agents:day");
  await new Promise((r) => setTimeout(r, quiet ? 500 : 6000));              // let the recap lines land in the recording
  const video = await require("../runtime/obs").stopRecording();
  const done = { ...ep, endedAt: Date.now(), video };
  writeJson(stateFile(), done);
  writeJson(path.join(dirOf(ep.day), "episode.json"), done);
  const out = exportEpisode(ep.day);
  log("episode", `day ${ep.day} ended - ${out.highlights} highlights, ${out.captions} caption lines${video ? ", video " + video : ""} -> ${dirOf(ep.day)}`);
}

/** Three short lines for the end of the day (AI if available, counted facts otherwise). */
async function recapOf(agent, ep) {
  const events = readLines(path.join(dirOf(ep.day), "events.jsonl"));
  const count = (k) => events.filter((e) => e.kind === k).length;
  const facts = events.filter((e) => e.kind !== "start").slice(-40).map((e) => `${e.agent}: ${e.kind} - ${e.text}`).join("\n");
  if (agent.brain?.available) {
    try {
      const r = await agent.brain.json(`You are ${agent.bot.username}, leader of a team of Minecraft AI players, ending "Day ${ep.day}" of a video series. The day's goal was: "${ep.goal}".
What happened today (log):\n${facts || "(quiet day)"}
Write the end-of-day recap you say in chat: exactly 3 short lines (<= 70 chars each), fun and in character, honest about what failed, the last line teases tomorrow.
Reply ONLY JSON: {"lines":["...","...","..."]}`, { timeoutMs: 15000 });
      if (Array.isArray(r?.lines) && r.lines.length) return r.lines.slice(0, 3).map((l) => String(l).slice(0, 90));
    } catch (e) { log("episode", "recap AI failed: " + e.message); }
  }
  return [`That's day ${ep.day}: ${ep.goal}.`, `${count("done")} jobs done, ${count("help")} calls for help, ${count("death")} deaths.`, "Rest up - tomorrow we go bigger."];
}

function readLines(f) { try { return fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } }
const clock = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };
const srtTime = (ms) => { ms = Math.max(0, Math.round(ms)); const h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, s = Math.floor(ms / 1000) % 60; return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(ms % 1000).padStart(3, "0")}`; };

/** highlights.md + captions.srt, timed to the recording (or to the episode start when nothing was recorded). */
function exportEpisode(day) {
  const dir = dirOf(day), ep = readJson(path.join(dir, "episode.json")) || {};
  const t0 = ep.recordingStartedAt || ep.startedAt || 0;
  const events = readLines(path.join(dir, "events.jsonl"));
  // every agent hears every line: keep one copy of each (same speaker + text within 4 s)
  const chat = [];
  for (const c of readLines(path.join(dir, "chat.jsonl")).sort((a, b) => a.wall - b.wall)) {
    if (/^\//.test(c.text)) continue;
    if (chat.some((x) => x.speaker === c.speaker && x.text === c.text && Math.abs(x.wall - c.wall) < 4000)) continue;
    chat.push(c);
  }
  const seenEv = [];
  const uniqEvents = events.filter((e) => { if (seenEv.some((x) => x.kind === e.kind && x.text === e.text && Math.abs(x.wall - e.wall) < 4000)) return false; seenEv.push(e); return true; });
  const ICON = { thought: "🧠", decision: "🤖", start: "🎬", plan: "🗺️", help: "🆘", rescue: "🏃", death: "💀", done: "✅", milestone: "🏆", end: "🏁", note: "📝" };
  const md = [`# Day ${day}: ${ep.goal || ""}`, "", ep.video ? `Recording: \`${ep.video}\`` : "Recording: (none - times are from the start of the day)", "",
    "## Highlights", "", "| time | | who | what |", "|---|---|---|---|",
    ...uniqEvents.map((e) => `| ${clock(e.wall - t0)} | ${ICON[e.kind] || "•"} ${e.kind} | ${e.agent} | ${String(e.text).replace(/\|/g, "/")} |`),
    "", "## Chat", "", ...chat.map((c) => `- \`${clock(c.wall - t0)}\` **${c.speaker}**: ${c.text}`), ""];
  fs.writeFileSync(path.join(dir, "highlights.md"), md.join("\n"));
  const srt = chat.map((c, i) => {
    const start = c.wall - t0, next = chat[i + 1] ? chat[i + 1].wall - t0 : start + 4000;
    return `${i + 1}\n${srtTime(start)} --> ${srtTime(Math.max(start + 1200, Math.min(start + 4000, next - 100)))}\n${c.speaker}: ${c.text}\n`;
  }).join("\n");
  fs.writeFileSync(path.join(dir, "captions.srt"), srt);
  return { highlights: uniqEvents.length, captions: chat.length };
}

const pickLine = (a) => a[Math.floor(Math.random() * a.length)];

module.exports = { onChat, mark, chatLine, current, exportEpisode, startEpisode, endEpisode, START, END, dirOf };
