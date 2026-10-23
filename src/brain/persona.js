// Character mode: an agent named after a well-known character talks like that character, for free - the model already knows them.
// Any name works ("Gandalf", "Sherlock", "Dracula"); a name that is not a known character just means a plain, friendly voice.
// CHARACTER_MODE=off turns it off.
const on = () => (process.env.CHARACTER_MODE || "on").toLowerCase() !== "off";

/** One prompt line (or "") that gives the model the agent's voice. */
function personaLine(name) {
  if (!on() || !name) return "";
  return `Your name is ${name}. If that is a famous (fictional or historical) character, speak the way that character would - their attitude, their phrases, their running jokes - but keep it short, funny, family-friendly and still a real teammate who answers the question. If it is not a known character, just be a casual, friendly player.`;
}

module.exports = { personaLine };
