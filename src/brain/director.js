// The agentic loop for anything the typed planner can't express. Observe -> think -> act -> verify -> repeat.
// It never blocks the executor: it hands typed sub-goals to the agent (fast, deterministic) or runs a script
// in the sandbox, and while those run it can re-review asynchronously if progress stalls.
const { observe } = require("../runtime/observe");
const { describeWorld } = require("./status");
const { runScript, API_DOC } = require("./sandbox");
const { GOAL_DOC } = require("./llm");
const learned = require("./learned");
const { sleep, isAbort, log } = require("../runtime/util");

const MAX_STEPS = 80;

function decisionPrompt({ text, world, history, chat, skillsDoc, note, team: a_team }) {
  return `You are the planner of an expert Minecraft player bot. Overall task from the player: "${text}"
Recent chat:\n${chat || "(none)"}
Current world state:\n${world}
What has been tried so far (newest last):\n${history || "(nothing yet)"}${note ? `\n${note}` : ""}
${GOAL_DOC}
Teammate AI agents you can command with the tell goal: ${(a_team || []).join(", ") || "none"}. As leader, split big objectives into concrete tasks for yourself and your teammates and tell them what to do.
Prefer a typed goal (fast, robust: it plans tools, crafting, digging, combat itself) whenever one fits. Use a script only for custom behaviour, and keep scripts short.
${API_DOC}
SHARED SKILL LIBRARY (scripts that already worked for you or a teammate - the most relevant ones; REUSE one with tool "run_skill", "skillName" and "args" instead of writing code; a skill that almost fits is still worth running with different args; if it fails it is repaired and the fix is saved for everybody):\n${skillsDoc || "(none relevant yet)"}
When you write a NEW script that could be useful again, make it REUSABLE: read what varies (item names, counts, coordinates, player names) from api.args.<name> - never hard-code coordinates of this world - and also give "skillName" (snake_case), "skillDescription" and "skillParams":[{"name":"","desc":""}] so it is saved to the library. One-off scripts need no skillName.
Never break beds, chests, doors, furnaces or crafting tables that already exist in the world (other players' property, protected): craft your own. Resources first: the inventory above is what you HAVE - use it, craft from it, and only gather/hunt what is genuinely missing. Dropped items and chests nearby count as resources: collect/look in them before mining or hunting. A typed goal {\"type\":\"have\"} already does all of this automatically.\nHow to work: decompose the task into SMALL steps and do one step per reply - either a typed goal or a short script (<= ~25 lines). Never try to solve everything in one big script. After each step you see the new world state and the outcome, then plan the next step. If a script returned ERROR you will get the error text: write a corrected script (different approach if the same error repeats). Keep going until the task is truly finished in the world.\nRules: verify with the world state before saying done - never claim success without evidence in the state above. If something failed, change approach (different resource, dig/pillar/bridge, craft a tool first) rather than repeating it. Think like a speedrunner.
Reply ONLY JSON: {"thought":"<=100 chars what you notice and why this step","tool":"goal|script|run_skill|say|done|give_up","goal":{...typed goal...},"code":"<script body>","skillName":"<optional>","args":{"<param>":"<value for run_skill, or for a script that reads api.args>"},"skillParams":[{"name":"","desc":""}],"skillDescription":"<optional>","say":"<=70 chars","reply":"<=70 chars final message to player when done or giving up"}`;
}

class Director {
  constructor(agent) { this.agent = agent; this.ctl = null; }

  cancel(why = "cancel") { if (this.ctl) { this.ctl.abort(); this.ctl = null; log("director", "cancelled:", why); } }

  async start(text, speaker, { quiet = false } = {}) {
    this.cancel("restart");
    const ctl = this.ctl = new AbortController();
    const a = this.agent;
    const say = quiet ? (m) => a.think(String(m).replace(/\s*Is there anything else you need\?$/, "")) : (m, o) => a.say(m, o);     // my own errands are not announced to the world
    const history = [];
    let candidate = null; // last script that ran OK; saved when the task is declared done
    const decide = (note = "") => {
      const snap = observe(a.bot);
      const prompt = decisionPrompt({ text, world: describeWorld(a, snap), history: history.slice(-8).map((h, i) => `${i + 1}. ${h}`).join("\n"), chat: `${a.ctxStore.summary().history}\nPlaces mentioned: ${a.ctxStore.summary().places}`, skillsDoc: learned.catalog(text), note, team: a.team });
      return a.brain.json(prompt, { timeoutMs: 25000, level: "MEDIUM", strong: true });
    };
    // Pipelining: while a step is running, the next decision is already being thought through (assuming success), so
    // there is no think -> act -> think pause. A failed step throws the prefetched decision away.
    let pending = null;
    const lookahead = (desc) => decide(`NOTE: this step is ALREADY RUNNING right now: ${desc}. The state above is from BEFORE it started. Assume it succeeds and decide the step AFTER it (reply "done" only if that step completes the whole task).`).catch(() => null);
    const failed = (o) => /gave up|blocked|stalled|no progress|ERROR|aborted|cancelled|stuck|ended/i.test(String(o));
    say(`Let me figure this out: ${text}`.slice(0, 120));
    try {
      for (let step = 1; step <= (quiet ? 25 : MAX_STEPS) && !ctl.signal.aborted; step++) {        // my own errand is short; a player's task may take longer
        let d;
        try {
          const pre = pending ? await pending : null; pending = null;
          d = pre || await decide();
        } catch (e) { log("director", "llm error:", e.message); if (!a.brain.available) { a.say("My AI service is unavailable right now, so I have to drop that task.", { force: true }); return; } await sleep(1500); history.push(`(planner unavailable: ${e.message})`); continue; }
        if (ctl.signal.aborted) return;
        if (d.thought) a.think(d.thought);
        log("director", `step ${step}: ${d.tool} ${d.goal ? JSON.stringify(d.goal) : ""}`);

        if (d.tool === "done") {
          // Voyager-style critic: an independent check against fresh state before we claim success
          if ((this.criticRejections || 0) < 2) {
            const verdict = await this.critic({ text, claim: d.reply || d.thought, snap: observe(a.bot), history, a }).catch(() => null);
            if (verdict && verdict.complete === false) {
              this.criticRejections = (this.criticRejections || 0) + 1;
              a.think(`not finished yet: ${String(verdict.missing || "").slice(0, 90)}`);
              history.push(`critic rejected "done": ${verdict.missing}`);
              continue;
            }
          }
          this.criticRejections = 0;
          const r = (d.reply || "I finished that.").trim(); say(/[?]\s*$/.test(r) ? r : `${r} Is there anything else you need?`, { force: true }); return;
        }
        if (d.tool === "give_up") { const r = (d.reply || "I couldn't manage that.").trim(); say(/[?]\s*$/.test(r) ? r : `${r} Should I try something else, or can you help?`, { force: true }); return; }
        if (d.tool === "say") { if (d.say) say(d.say); history.push(`said: ${d.say}`); continue; }

        if (d.tool === "goal" && d.goal) {
          const { validateGoal } = require("./llm");
          const g = d.goal.type === "freeform" ? null : validateGoal(d.goal, { reg: a.reg, speaker, team: a.team });
          if (!g) { history.push(`invalid goal ${JSON.stringify(d.goal)}`); continue; }
          // trailing after a player is only done when the task asks for it ("follow me", "come with me") - never as a way of "seeing what they need"
          if ((g.type === "follow" || g.type === "come") && !/\b(follow|come|escort|accompany|stay with|with me|join me)\b/i.test(text)) { history.push(`not allowed: ${g.type} ${g.player} - nobody asked you to follow; do the task itself or reply done`); continue; }
          pending = lookahead(`typed goal ${JSON.stringify(g)}`);
          const outcome = await this.runGoal(g, ctl.signal);
          if (failed(outcome)) pending = null;
          history.push(`goal ${JSON.stringify(g)} -> ${outcome}`);
        } else if ((d.tool === "script" && d.code) || (d.tool === "run_skill" && d.skillName)) {
          const saved = d.tool === "run_skill" ? learned.find(d.skillName) : null;
          if (d.tool === "run_skill" && !saved) { history.push(`no saved skill named ${d.skillName}`); continue; }
          const code = saved ? saved.code : d.code;
          a.think(saved ? `using saved skill "${saved.name}"` : `no built-in action fits - writing a new script: ${(d.thought || text).slice(0, 90)}`);
          pending = lookahead(`a script (${(d.thought || "").slice(0, 80)})`);
          let outcome = await this.runCode(code, ctl.signal, d.args);
          if (failed(outcome)) pending = null;
          if (outcome.startsWith("ERROR")) a.think(`script failed: ${outcome.slice(6, 90)}`);
          // immediate self-repair: feed the error back and retry up to 3 times before returning to the planner
          let fixedCode = code;
          for (let attempt = 1; attempt <= 3 && outcome.startsWith("ERROR") && !ctl.signal.aborted; attempt++) {
            a.think(`self-healing: rewriting the script (attempt ${attempt}/3)`);
            const fix = await this.repair({ text, thought: d.thought, code: fixedCode, error: outcome, snap: observe(a.bot), a, skill: saved, args: d.args }).catch((e) => { log("director", "repair llm error", e.message); return null; });
            if (!fix?.code) break;
            fixedCode = fix.code;
            outcome = await this.runCode(fixedCode, ctl.signal, d.args);
            if (outcome.startsWith("ok")) { outcome += ` (after ${attempt} repair${attempt > 1 ? "s" : ""})`; a.think(`self-healed: the fixed script worked (${attempt} repair${attempt > 1 ? "s" : ""})`); }
            else a.think(`repair ${attempt} failed: ${outcome.slice(6, 80)}`);
          }
          if (outcome.startsWith("ERROR")) { a.think("script still failing after repairs - planning a different approach"); this.failStreak = (this.failStreak || 0) + 1; if (this.failStreak >= 3) { a.say("My scripts keep failing on this; I'll keep trying other approaches.", { force: true }); this.failStreak = 0; } } else this.failStreak = 0;
          if (outcome.startsWith("ok")) d.code = fixedCode;
          const me = a.bot.username, repaired = fixedCode !== code;
          if (saved) {
            if (outcome.startsWith("ok")) {
              if (repaired) learned.save({ name: saved.name, description: saved.description, params: saved.params, code: fixedCode, by: me }, (n, sk) => a.think(`improved the shared skill "${n}" (v${sk.version}) for everyone`));
              learned.record(saved.name, { ok: true });
            } else learned.record(saved.name, { ok: false, error: outcome.slice(6) });
          } else if (outcome.startsWith("ok") && d.skillName) {
            learned.save({ name: d.skillName, description: d.skillDescription || d.thought, params: d.skillParams, code: fixedCode, by: me }, (n) => a.think(`saved as reusable skill "${n}"`));
            learned.record(d.skillName, { ok: true });
          }
          history.push(`${saved ? "skill " + saved.name : "script"} (${(d.thought || "").slice(0, 60)}) -> ${outcome}`);
        } else history.push(`unusable decision ${JSON.stringify(d).slice(0, 80)}`);
      }
      if (!ctl.signal.aborted) say("I've tried a lot of steps without finishing and I'm stopping here. What would you like me to do?", { force: true });
    } catch (e) { if (!isAbort(e)) log("director", "error:", e.stack || e.message); }
    finally { if (this.ctl === ctl) this.ctl = null; }
  }

  // Hand a typed goal to the executor and wait for it; wake early if it stalls so the LLM can re-plan.
  async runGoal(goal, signal) {
    const a = this.agent;
    goal.sub = true;                      // a step of a bigger task: finishes quietly
    a.setGoal(goal, { keepQueue: true });
    const id = goal.id, t0 = Date.now();
    for (;;) {
      if (signal.aborted) return "cancelled";
      await sleep(400);
      if (a.goal?.id !== id) return a.lastGoalOutcome?.id === id ? a.lastGoalOutcome.text : "ended";
      const stalled = a.ledger.length >= 3 && !a.ledger.slice(-3).some((e) => e.after < e.before - 1e-6);
      if (stalled || Date.now() - t0 > 180000) { const note = `still running after ${Math.round((Date.now() - t0) / 1000)}s, no progress (${a.ledger.slice(-1)[0]?.reason || "?"})`; a.clearGoal(); return note; }
    }
  }

  async critic({ text, claim, snap, history, a }) {
    const prompt = `You are a strict Minecraft task critic. Task: "${text}". The planner claims it is done: "${claim}".
Current world state (ground truth):\n${describeWorld(a, snap)}
Recent steps:\n${history.slice(-5).join("\n")}
Judge ONLY from the state and steps above whether the task is truly complete. If something is clearly missing (e.g. items not in inventory, bot not at the place, structure not finished), say so.
Reply ONLY JSON: {"complete":true|false,"missing":"<=80 chars what is still missing, empty if complete"}`;
    return a.brain.json(prompt, { timeoutMs: 15000, level: "LOW", strong: true });
  }

  async repair({ text, thought, code, error, snap, a, skill = null, args = null }) {
    const lib = skill ? `\nThis is the SHARED skill "${skill.name}" (${skill.description}; v${skill.version}, used by several teammates in different situations). It was run with args ${JSON.stringify(args || {})}. Fix it so it works GENERALLY - keep reading what varies from api.args, do not special-case this one situation - and keep the parameters it already has.` : "";
    const prompt = `A Minecraft bot script failed. Overall task: "${text}". This step: "${thought || ""}".${lib}
World now:\n${describeWorld(a, snap)}
Failed script:\n${code}\n${error}
${API_DOC}
Fix the bug (wrong API usage, wrong coordinates, missing item, blocked path...). If the approach itself is wrong, change it. Keep the script short.
Reply ONLY JSON: {"code":"<corrected script body>","note":"<=80 chars what you changed"}`;
    const r = await a.brain.json(prompt, { timeoutMs: 20000, level: "MEDIUM", strong: true });
    if (r?.note) a.think(`fix: ${r.note}`);
    return r;
  }

  async runCode(code, signal, args = {}) {
    const a = this.agent;
    const ctl = new AbortController();
    const onAbort = () => ctl.abort(); signal.addEventListener("abort", onAbort, { once: true });
    a.active.add(ctl);   // registered, never overwriting the main loop's own current action
    try {
      const ctx = { bot: a.bot, reg: a.reg, mem: a.mem, agent: a, signal: ctl.signal, beat: () => { a.lastBeat = Date.now(); } };
      const r = await runScript(ctx, code, { args });
      if (r.ok) return `ok${r.value != null ? " -> " + JSON.stringify(r.value).slice(0, 100) : ""}${r.logs.length ? " logs: " + r.logs.slice(-3).join(" | ") : ""}`;
      return `ERROR ${r.error}${r.logs.length ? " logs: " + r.logs.slice(-3).join(" | ") : ""}`;
    } catch (e) { return isAbort(e) ? "aborted" : `ERROR ${e.message}`; }
    finally { signal.removeEventListener("abort", onAbort); for (const c of ["forward", "back", "left", "right", "sprint", "jump"]) a.bot.setControlState(c, false); try { a.bot.pathfinder.stop(); } catch {} a.active.delete(ctl); }
  }
}

module.exports = { Director };
