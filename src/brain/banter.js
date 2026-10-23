// Real players talk to each other without being told to. This gives the agents a reason and a voice: now and then one of them checks on a
// teammate, offers help to someone who is hurt, comments on what it just finished, or (the leader) suggests what the team does next.
// Lines are short and written by the fast model from the real team state; the addressed teammate may answer once or twice, then it is quiet.
// Humans' orders always come first, and nothing here ever changes what anybody is doing - except a leader's proposal, which goes through the project board.
const { log } = require("../runtime/util");
const team = require("../runtime/team");

class Banter {
  constructor(agent) {
    this.agent = agent;
    this.next = Date.now() + 45000 + Math.random() * 75000;
    this.convo = new Map();                 // partner -> {n, t}: how many replies in the current exchange (never an endless back-and-forth)
    this.heard = new Map();                 // text -> t: the same line heard twice (chat + inbox) is answered once
    this.lastReply = 0;
    this.enabled = (process.env.MC_BANTER || "on").toLowerCase() !== "off";
  }
  get me() { return this.agent.bot.username; }

  quiet() {
    const a = this.agent;
    return !this.enabled || !a.alive || a.dead || a.bot.isSleeping || (a.lastHumanCommand && Date.now() - a.lastHumanCommand < 60000)
      || (a.bot.game?.gameMode !== "creative" && (a.bot.health ?? 20) < 8) || a.goal?.type === "hideout" || !a.brain?.available;
  }

  recentChat() { return (this.agent.ctxStore.chat || []).slice(-8).map((c) => `${c.speaker}: ${c.text}`).join("\n") || "(quiet)"; }

  async line(reason, extra = "") {
    const a = this.agent;
    const { describeActivity } = require("./status");
    const mates = team.readTeam(this.me).map((t) => `${t.name} (${t.role}, ${t.activity || "idle"}, hp ${t.hp})`).join("; ");
    const prompt = `You are ${this.me}, ${a.role} in a small Minecraft survival team, typing in the game chat. Right now you are: ${describeActivity(a)}.
Teammates: ${mates}.
Recent chat:\n${this.recentChat()}
Why you speak now: ${reason}${extra ? "\n" + extra : ""}
Write ONE short natural chat line (max 14 words), casual like a person playing, no emojis, no quotes, no "As an AI". Only say things that are true given the info above. Name a teammate only if it fits.
Reply ONLY JSON: {"line":"...","to":"<teammate name or empty>"}`;
    try { const out = await a.brain.json(prompt, { timeoutMs: 12000, level: "LOW" }); return out?.line ? { text: String(out.line).slice(0, 140), to: out.to || "" } : null; }
    catch (e) { log("banter", "no line: " + e.message); return null; }
  }

  /** Called every couple of seconds from the team tick. */
  async tick() {
    const now = Date.now();
    if (now < this.next || this.busy || this.quiet()) return;
    const a = this.agent, mates = team.readTeam(this.me);
    if (!mates.length) { this.next = now + 60000; return; }
    this.busy = true;
    try {
      this.next = now + 90000 + Math.random() * 110000;
      const hurt = mates.find((m) => m.hp != null && m.hp <= 8);
      const last = a.autonomy.journal[a.autonomy.journal.length - 1];
      const board = require("../runtime/project");
      const noProject = !board.active().length;
      let reason, to = "";
      if (hurt) { reason = `${hurt.name} is low on health (${hurt.hp}) - offer help or ask if they need food`; to = hurt.name; }
      else if (a.role === "leader" && noProject && Date.now() - Math.max(a.lastHumanCommand || 0, ...mates.map((m) => m.lastHuman || 0)) > 20 * 60000 && mates.every((m) => !m.activity || /idle|cook|hunt|mine|craft|get/.test(m.activity))) {
        reason = "the team has no shared project right now - suggest what to do next together (you are the leader)";
        const l = await this.line(reason);
        if (l) { a.say(l.text, { noName: true, force: true }); }
        a.projects.proposeProject().catch((e) => log("banter", "proposal failed: " + e.message));
        return;
      }
      else if (last && now - last.t < 240000 && last.outcome === "done") reason = `you just finished: ${last.goal} - mention it briefly`;
      else { const m = mates[Math.floor(Math.random() * mates.length)]; reason = `check in with ${m.name} about how their ${m.activity || "work"} is going`; to = m.name; }
      const l = await this.line(reason);
      if (!l) return;
      a.say(l.text, { noName: true, force: true });
      const target = l.to || to;
      if (target && mates.some((m) => m.name.toLowerCase() === String(target).toLowerCase())) team.send(this.me, mates.find((m) => m.name.toLowerCase() === String(target).toLowerCase()).name, { type: "chat", text: l.text, data: { hops: 0 } });
    } finally { this.busy = false; }
  }

  /** A teammate spoke to me: answer once, naturally; the exchange dies after two hops. */
  async onChat(m) {
    const now = Date.now(), hops = m.data?.hops || 0;
    const sig = String(m.text).toLowerCase().replace(/\W+/g, " ").trim();
    for (const [k, t] of this.heard) if (now - t > 60000) this.heard.delete(k);
    if (this.heard.has(sig)) return;
    this.heard.set(sig, now);
    const c = this.convo.get(m.from) || { n: 0, t: 0 };
    if (now - c.t > 180000) c.n = 0;                                          // a new conversation
    if (this.quiet() || hops >= 2 || c.n >= 2 || now - this.lastReply < 8000) return;
    c.n++; c.t = now; this.convo.set(m.from, c);
    this.lastReply = now;
    const l = await this.line(`${m.from} just said to you: "${m.text}" - answer them directly`);
    if (!l) return;
    this.agent.say(l.text, { noName: true, force: true });
    if (hops < 1 && /\?\s*$/.test(m.text)) team.send(this.me, m.from, { type: "chat", text: l.text, data: { hops: hops + 1 } });
  }
}

module.exports = { Banter };
