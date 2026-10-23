// Small shared helpers. Everything long-running takes an AbortSignal and honours it.
class AbortError extends Error {
  constructor(msg = "aborted") { super(msg); this.name = "AbortError"; }
}

const isAbort = (e) => e && e.name === "AbortError";

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new AbortError());
    const t = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(t); reject(new AbortError()); };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function throwIfAborted(signal) { if (signal?.aborted) throw new AbortError(); }

// Resolve when `check()` is truthy; reject on timeout (null) or abort.
async function waitFor(check, { timeout = 5000, interval = 50, signal } = {}) {
  const start = Date.now();
  for (;;) {
    throwIfAborted(signal);
    const v = check();
    if (v) return v;
    if (Date.now() - start > timeout) return null;
    await sleep(interval, signal);
  }
}

const ok = (data) => ({ ok: true, data });
const fail = (reason, data) => ({ ok: false, reason, data });

const pos3 = (v) => ({ x: Math.round(v.x * 10) / 10, y: Math.round(v.y * 10) / 10, z: Math.round(v.z * 10) / 10 });
const key3 = (v) => `${Math.floor(v.x)},${Math.floor(v.y)},${Math.floor(v.z)}`;
const dist2 = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const dist3 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

function invCount(bot, name) {
  let n = 0;
  for (const it of bot.inventory.items()) if (it.name === name) n += it.count;
  return n;
}

function invMap(bot) {
  const m = {};
  for (const it of bot.inventory.items()) m[it.name] = (m[it.name] || 0) + it.count;
  return m;
}

// Logger that stamps elapsed time; one place to silence or redirect.
const T0 = Date.now();
const log = (tag, ...a) => console.log(`[${((Date.now() - T0) / 1000).toFixed(1).padStart(6)}s][${tag}]`, ...a);

// Event-loop health: a bot that blocks its loop for >100 ms stops sending movement packets (it visibly "freezes while thinking").
// timed() names the culprit; watchLag() reports any stall with whatever timed() section was running most recently.
let lastSection = "?";
function timed(name, fn, warnMs = 60) {
  const t = Date.now(); lastSection = name;
  const r = fn();
  const dt = Date.now() - t;
  if (dt > warnMs) log("lag", `${name} blocked the loop for ${dt}ms`);
  return r;
}
function watchLag(thresholdMs = 120) {
  let last = Date.now();
  const iv = setInterval(() => { const now = Date.now(), drift = now - last - 50; last = now; if (drift > thresholdMs) log("lag", `event loop stalled ${drift}ms (last section: ${lastSection})`); }, 50);
  iv.unref?.();
  return iv;
}

// Durable JSON: write to a temp file, keep the previous good copy as .bak, rename into place (a crash never leaves half a file);
// reading falls back to the .bak when the main file is missing or corrupt.
const fs = require("fs");
const pathMod = require("path");
function writeJsonAtomic(file, obj) {
  fs.mkdirSync(pathMod.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj));
  try { if (fs.existsSync(file)) fs.copyFileSync(file, file + ".bak"); } catch { /* no backup this time */ }
  fs.renameSync(tmp, file);
}
function readJsonSafe(file) {
  for (const f of [file, file + ".bak"]) { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { /* try the backup */ } }
  return null;
}

module.exports = { writeJsonAtomic, readJsonSafe, timed, watchLag, AbortError, isAbort, sleep, throwIfAborted, waitFor, ok, fail, pos3, key3, dist2, dist3, invCount, invMap, log };
