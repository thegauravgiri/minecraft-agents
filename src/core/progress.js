// Pure progress assessment over the action ledger. This is what replaces "hope the LLM notices".
// Each entry: { sig, before, after, ok, reason, pos }, where before/after are plan `remaining` values.
const improved = (e) => e.after < e.before - 1e-6;

function assess(ledger, { window = 8 } = {}) {
  if (!ledger.length) return { state: "ok" };
  const recent = ledger.slice(-window);
  const last = recent[recent.length - 1];
  if (improved(last)) return { state: "ok" };

  // same action, no progress, N times in a row
  let streak = 0;
  for (let i = recent.length - 1; i >= 0; i--) {
    if (recent[i].sig === last.sig && !improved(recent[i])) streak++; else break;
  }
  if (streak >= 3) return { state: "stalled", sig: last.sig, streak, reason: last.reason };
  if (!last.ok && streak >= 2) return { state: "stalled", sig: last.sig, streak, reason: last.reason };

  // ping-pong between a couple of actions without ever improving
  if (recent.length >= 6) {
    const sigs = new Set(recent.map((e) => e.sig));
    if (sigs.size <= 2 && !recent.some(improved)) return { state: "looping", sigs: [...sigs] };
  }

  // no improvement for a long window, regardless of what was tried
  if (ledger.length >= window && !recent.some(improved)) return { state: "stalled", sig: last.sig, streak: window, reason: "no_progress_window" };
  return { state: "ok" };
}

// Which escalation rung are we on? Counts how many times we have already intervened for this goal.
const LADDER = ["retry", "avoid_source", "relocate", "ask_advisor", "give_up"];
const rung = (n) => LADDER[Math.min(n, LADDER.length - 1)];

module.exports = { assess, improved, rung, LADDER };
