// OBS Studio remote control (obs-websocket v5, built into OBS 28+): start/stop recording for episodes.
// Configured with OBS_WS_URL (default ws://127.0.0.1:4455) and OBS_WS_PASSWORD in .env. Without a password nothing is recorded.
const { log } = require("./util");

let conn = null;
async function client() {
  if (!process.env.OBS_WS_PASSWORD) return null;
  if (conn) return conn;
  const { OBSWebSocket } = require("obs-websocket-js");
  const o = new OBSWebSocket();
  await o.connect(process.env.OBS_WS_URL || "ws://127.0.0.1:4455", process.env.OBS_WS_PASSWORD);
  o.on("ConnectionClosed", () => { conn = null; });
  conn = o;
  return o;
}

const enabled = () => !!process.env.OBS_WS_PASSWORD && (process.env.EPISODE_RECORD || "on").toLowerCase() !== "off";

/** Start recording. Returns the wall-clock time recording started, or null (not configured / failed). */
async function startRecording() {
  if (!enabled()) return null;
  try {
    const o = await client();
    const st = await o.call("GetRecordStatus");
    if (st.outputActive) { log("obs", "already recording"); return Date.now() - (st.outputDuration || 0); }
    await o.call("StartRecord");
    log("obs", "recording started");
    return Date.now();
  } catch (e) { log("obs", "could not start recording: " + e.message); return null; }
}

/** Stop recording. Returns the path of the video file, or null. */
async function stopRecording() {
  if (!enabled()) return null;
  try {
    const o = await client();
    const st = await o.call("GetRecordStatus");
    if (!st.outputActive) return null;
    const r = await o.call("StopRecord");
    log("obs", `recording saved: ${r.outputPath}`);
    return r.outputPath || null;
  } catch (e) { log("obs", "could not stop recording: " + e.message); return null; }
}

module.exports = { enabled, startRecording, stopRecording, client };
