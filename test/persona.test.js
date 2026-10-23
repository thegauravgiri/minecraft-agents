const assert = require("assert");
const { personaLine } = require("../src/brain/persona");
assert(/Sherlock/.test(personaLine("Sherlock")) && /famous/.test(personaLine("Sherlock")), "the agent's name is in the voice line");
process.env.CHARACTER_MODE = "off";
assert.strictEqual(personaLine("Sherlock"), "", "off means no voice line");
delete process.env.CHARACTER_MODE;
assert.strictEqual(personaLine(""), "");
console.log("persona tests passed");
