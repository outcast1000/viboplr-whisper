// The plugin's job logic against a fake host API: what it saves, what it
// skips, what it tells the user. Loads the built index.js the way the host's
// loader does (a function body taking `api`, returning { activate, deactivate }).
const { test } = require("node:test");
const assert = require("node:assert");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const CODE = readFileSync(join(__dirname, "..", "index.js"), "utf8");

const PLAIN = "Paper boats along the river\nCarry every word I never said";
const TRANSCRIPT_LINES = [[10, "Paper boats along the river"], [13, "Carry every word I never said"]];

function whisperJson(lines) {
  return {
    transcription: lines.map(([start, text]) => ({
      offsets: { from: start * 1000 },
      text,
      tokens: text.split(" ").map((w, i) => ({ text: " " + w, offsets: { from: (start + i * 0.3) * 1000 }, t_dtw: Math.round((start + i * 0.3) * 100), p: 0.98 })),
    })),
  };
}

// [[fromSecs, toSecs, "text"]] → what `whisper-cli -ojf -ml N -sow` writes.
function segmentJson(list) {
  return { transcription: list.map(([from, to, text]) => ({ offsets: { from: from * 1000, to: to * 1000 }, text: " " + text })) };
}

function fakeHost(opts = {}) {
  const files = new Map(Object.entries(opts.files || { "models/ggml-large-v3-turbo-q5_0.bin": "model" }));
  const store = new Map();
  const handlers = { menu: {}, ui: {}, tools: {}, trackStarted: null };
  const calls = { exec: [], saves: [], notes: [], fetches: 0, views: 0, lastView: null, requests: [] };
  let whisperMissing = !!opts.whisperMissing;
  const installListeners = [];
  let lyrics = opts.lyrics === undefined ? { kind: "plain", text: PLAIN } : opts.lyrics;
  const tracks = opts.tracks || { 7: { id: 7, title: "Harbour", artist_name: "Glass Harbour", album_title: "Tides", duration_secs: 200, path: "file:///music/harbour.flac" } };
  let currentTrack = null;

  const api = {
    log() {},
    storage: {
      get: async (k) => store.get(k),
      set: async (k, v) => { store.set(k, v); },
      files: {
        exists: async (p) => files.has(p.join("/")),
        // Like the host: a path only for a file that exists, else null.
        getPath: async (p) => (files.has(p.join("/")) ? "/store/" + p.join("/") : null),
        writeText: async (p, s) => { files.set(p.join("/"), s); },
        readJson: async (p) => {
          const v = files.get(p.join("/"));
          if (v === undefined) throw new Error("no such file " + p.join("/"));
          return v;
        },
        remove: async (p) => { files.delete(p.join("/")); },
      },
    },
    system: {
      getDependency: async () => (whisperMissing ? { name: "whisper-cli", installed: false } : { name: "whisper-cli", installed: true, version: "1.9.6-5907-1" }),
      exec: async (program, args, o) => {
        calls.exec.push({ program, args });
        if (o && o.onStart) o.onStart({ cancel: async () => true });
        if (program === "whisper-cli") {
          if (opts.whisperFails) return { exitCode: 1, stdout: "", stderr: "error: failed to read audio" };
          if (o && o.onOutput) o.onOutput("whisper_print_progress_callback: progress =  50%", "stderr");
          const outBase = args[args.indexOf("-of") + 1].replace("/store/", "");
          files.set(outBase + ".json", opts.segments ? segmentJson(opts.segments) : whisperJson(opts.transcript || TRANSCRIPT_LINES));
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      ...(opts.hearsInstalls ? { onDependencyInstalled: (h) => { installListeners.push(h); return () => {}; } } : {}),
      programs: { download: async (p) => { files.set(p.join("/"), "model"); return { path: "/store/" + p.join("/"), sha256: "x", size: 1 }; } },
    },
    informationTypes: {
      fetch: async () => { calls.fetches++; return lyrics ? { status: "ok", value: lyrics } : { status: "not_found" }; },
    },
    lyrics: { save: async (track, l) => { calls.saves.push({ track, l }); return { savedTo: "app" }; } },
    library: {
      getTrackById: async (id) => tracks[id] || null,
      findTrack: async ({ title }) => Object.values(tracks).filter((t) => t.title === title),
    },
    contextMenu: { onAction: (id, h) => { handlers.menu[id] = h; return () => {}; } },
    playback: {
      onTrackStarted: (h) => { handlers.trackStarted = h; return () => {}; },
      getCurrentTrack: () => currentTrack,
    },
    ui: {
      setViewData: (id, data) => { calls.views++; calls.lastView = data; },
      showNotification: (message, o) => { calls.notes.push({ message, kind: o && o.kind, action: o && o.action }); },
      onAction: (id, h) => { handlers.ui[id] = h; return () => {}; },
      requestAction: (action, payload) => { calls.requests.push({ action, payload }); },
    },
    assistant: { onTool: (name, h) => { handlers.tools[name] = h; return () => {}; } },
  };
  return {
    api, handlers, calls, files, store,
    setLyrics(l) { lyrics = l; },
    setCurrent(t) { currentTrack = t; },
    installWhisper() { whisperMissing = false; },
    announceInstall(change) { installListeners.forEach((h) => h(change)); },
    installListenerCount: () => installListeners.length,
  };
}

async function start(host) {
  const plugin = new Function("api", CODE)(host.api);
  plugin.activate(host.api);
  await settle();
  return plugin;
}

const settle = () => new Promise((r) => setTimeout(r, 20));

async function syncById(host, id) {
  host.handlers.menu["sync-lyrics"]({ kind: "track", trackId: id });
  for (let i = 0; i < 50 && !host.store.get("recent")?.length; i++) await settle();
}

test("plain lyrics on a local file are timed and saved as synced", async () => {
  const host = fakeHost();
  const p = await start(host);
  await syncById(host, 7);
  assert.equal(host.calls.saves.length, 1);
  const saved = host.calls.saves[0];
  assert.deepEqual(saved.track, { title: "Harbour", artistName: "Glass Harbour", albumTitle: "Tides" });
  assert.equal(saved.l.kind, "synced");
  assert.equal(saved.l.text, "[00:09.75]Paper boats along the river\n[00:12.75]Carry every word I never said");
  const whisper = host.calls.exec.find((c) => c.program === "whisper-cli").args;
  for (const flag of ["-nfa", "-ojf", "-pp"]) assert.ok(whisper.includes(flag), flag);
  assert.equal(whisper[whisper.indexOf("-dtw") + 1], "large.v3.turbo");
  assert.match(whisper[whisper.indexOf("--prompt") + 1], /^Paper boats along the river Carry/);
  assert.equal(host.calls.exec.find((c) => c.program === "ffmpeg").args.includes("/music/harbour.flac"), true);
  assert.equal(host.calls.notes.at(-1).kind, "success");
  assert.ok(![...host.files.keys()].some((k) => k.startsWith("tmp/job-")), "temp files removed");
  p.deactivate();
});

test("a song with no lyrics is skipped and whisper never runs", async () => {
  const host = fakeHost({ lyrics: null });
  const p = await start(host);
  await syncById(host, 7);
  assert.equal(host.calls.saves.length, 0);
  assert.equal(host.calls.exec.length, 0);
  assert.equal(host.store.get("recent")[0].status, "skipped");
  assert.match(host.calls.notes.at(-1).message, /No lyrics to time/);
  p.deactivate();
});

test("already-synced lyrics are left alone", async () => {
  const host = fakeHost({ lyrics: { kind: "synced", text: "[00:01.00]x" } });
  const p = await start(host);
  await syncById(host, 7);
  assert.equal(host.calls.exec.length, 0);
  assert.equal(host.store.get("recent")[0].detail, "Already synced");
  p.deactivate();
});

test("lyrics that come from the song's own file are skipped, since a cache save would be undone", async () => {
  const host = fakeHost({ lyrics: { kind: "plain", text: PLAIN, local: true } });
  const p = await start(host);
  await syncById(host, 7);
  assert.equal(host.calls.exec.length, 0);
  assert.match(host.store.get("recent")[0].detail, /song's file/);
  p.deactivate();
});

test("a track that isn't a local file is skipped", async () => {
  const host = fakeHost({ tracks: { 7: { id: 7, title: "Harbour", artist_name: "X", duration_secs: 200, path: "subsonic://1/abc" } } });
  const p = await start(host);
  await syncById(host, 7);
  assert.equal(host.calls.exec.length, 0);
  assert.equal(host.store.get("recent")[0].detail, "Not a local file");
  p.deactivate();
});

test("a poor match saves nothing and says so", async () => {
  const host = fakeHost({ transcript: [[10, "something else entirely sung here"]] });
  const p = await start(host);
  await syncById(host, 7);
  assert.equal(host.calls.saves.length, 0);
  assert.equal(host.store.get("recent")[0].status, "low-confidence");
  assert.equal(host.calls.notes.at(-1).kind, "warning");
  p.deactivate();
});

test("lyrics that became synced while whisper ran are not overwritten", async () => {
  const host = fakeHost();
  const realExec = host.api.system.exec;
  host.api.system.exec = async (program, args, o) => {
    const r = await realExec(program, args, o);
    if (program === "whisper-cli") host.setLyrics({ kind: "synced", text: "[00:01.00]edited by hand" });
    return r;
  };
  const p = await start(host);
  await syncById(host, 7);
  assert.equal(host.calls.saves.length, 0);
  assert.match(host.store.get("recent")[0].detail, /changed while/);
  p.deactivate();
});

test("a missing model or whisper-cli fails with a reason, before any work", async () => {
  for (const [opts, re] of [[{ files: {} }, /model/], [{ whisperMissing: true }, /whisper-cli/]]) {
    const host = fakeHost(opts);
    const p = await start(host);
    await syncById(host, 7);
    assert.equal(host.calls.exec.length, 0);
    assert.match(host.store.get("recent")[0].detail, re);
    assert.equal(host.calls.notes.at(-1).kind, "error");
    p.deactivate();
  }
});

test("a whisper failure is reported and temp files are still removed", async () => {
  const host = fakeHost({ whisperFails: true });
  const p = await start(host);
  await syncById(host, 7);
  assert.equal(host.store.get("recent")[0].status, "failed");
  assert.match(host.store.get("recent")[0].detail, /failed to read audio/);
  assert.ok(![...host.files.keys()].some((k) => k.startsWith("tmp/job-")));
  p.deactivate();
});

test("automatic mode is off by default: a started song does nothing", async () => {
  const host = fakeHost();
  const p = await start(host);
  const t = { key: "q:1", title: "Harbour", artist_name: "Glass Harbour", duration_secs: 200, path: "file:///music/harbour.flac" };
  host.setCurrent(t);
  host.handlers.trackStarted(t);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(host.calls.fetches, 0);
  p.deactivate();
});

test("the assistant tool finds the library song and returns the outcome", async () => {
  const host = fakeHost();
  const p = await start(host);
  const r = await host.handlers.tools.sync_lyrics({ title: "Harbour", artistName: "Glass Harbour" });
  assert.equal(r.status, "saved");
  await assert.rejects(() => host.handlers.tools.sync_lyrics({}), /title is required/);
  p.deactivate();
});

// The whisper-cli row's description, as the settings panel shows it.
function whisperRow(host) {
  const row = host.calls.lastView.children.find((c) => c.label === "whisper-cli");
  return row.description;
}

test("the panel updates as soon as the host says whisper-cli was installed", async () => {
  const host = fakeHost({ whisperMissing: true, hearsInstalls: true });
  const p = await start(host);
  assert.match(whisperRow(host), /^Not installed/);
  host.handlers.ui["install-whisper"]();
  assert.deepEqual(host.calls.requests[0], { action: "require-dependency", payload: { name: "whisper-cli", feature: "Sync lyrics with Whisper" } });

  // Another tool landing changes nothing; ours redraws the row.
  host.installWhisper();
  const before = host.calls.views;
  host.announceInstall({ name: "yt-dlp", version: "2026.11.20" });
  await settle();
  assert.equal(host.calls.views, before);
  host.announceInstall({ name: "whisper-cli", version: "1.9.6-5907-1" });
  await settle();
  assert.equal(whisperRow(host), "Installed · 1.9.6-5907-1");
  p.deactivate();
});

test("an install started from Extensions → Tools also updates the panel, with no click here", async () => {
  const host = fakeHost({ whisperMissing: true, hearsInstalls: true });
  const p = await start(host);
  host.installWhisper();
  host.announceInstall({ name: "whisper-cli", version: "1.9.6-5907-1" });
  await settle();
  assert.equal(whisperRow(host), "Installed · 1.9.6-5907-1");
  p.deactivate();
});

test("on a host without the install event, Install still re-checks on a timer", async () => {
  const host = fakeHost({ whisperMissing: true });
  const p = await start(host);
  assert.equal(host.installListenerCount(), 0);
  const realSetInterval = global.setInterval;
  let tick = null;
  global.setInterval = (fn) => { tick = fn; return 0; };
  try {
    host.handlers.ui["install-whisper"]();
  } finally {
    global.setInterval = realSetInterval;
  }
  assert.equal(typeof tick, "function");
  host.installWhisper();
  tick();
  await settle();
  assert.equal(whisperRow(host), "Installed · 1.9.6-5907-1");
  p.deactivate();
});

// ------------------------------------------------------------ transcription

const VIDEO = { 9: { id: 9, title: "Talk 2", artist_name: "Harbour Talks", duration_secs: 600, path: "file:///videos/talk2.mp4", kind: "video" } };
const SPEECH = [[2, 5, "Welcome to the harbour."], [5.5, 8, "Today we talk about boats."]];

async function transcribeById(host, id) {
  host.handlers.menu["transcribe"]({ kind: "track", trackId: id });
  for (let i = 0; i < 50 && !host.store.get("recent")?.length; i++) await settle();
}

test("a video with no lyrics is transcribed and saved as synced lyrics (its subtitles)", async () => {
  const host = fakeHost({ lyrics: null, tracks: VIDEO, segments: SPEECH });
  const p = await start(host);
  await transcribeById(host, 9);
  assert.equal(host.calls.saves.length, 1);
  const saved = host.calls.saves[0];
  assert.deepEqual(saved.track, { title: "Talk 2", artistName: "Harbour Talks", albumTitle: null });
  assert.equal(saved.l.kind, "synced");
  assert.equal(saved.l.text, "[00:02.00]Welcome to the harbour.\n[00:05.50]Today we talk about boats.\n[00:08.00]\n[10:00.00]");
  const whisper = host.calls.exec.find((c) => c.program === "whisper-cli").args;
  assert.equal(whisper[whisper.indexOf("-ml") + 1], "84");
  for (const flag of ["-sow", "-ojf"]) assert.ok(whisper.includes(flag), flag);
  for (const flag of ["-dtw", "--prompt"]) assert.ok(!whisper.includes(flag), flag + " is for syncing only");
  assert.equal(host.store.get("recent")[0].mode, "transcribe");
  assert.match(host.calls.notes.at(-1).message, /^Transcribed Talk 2 .*subtitles/);
  assert.equal(host.calls.notes.at(-1).kind, "success");
  assert.ok(![...host.files.keys()].some((k) => k.startsWith("tmp/job-")), "temp files removed");
  p.deactivate();
});

test("transcription never replaces lyrics the track already has", async () => {
  for (const [lyrics, re] of [
    [{ kind: "plain", text: PLAIN }, /Sync lyrics with Whisper/],
    [{ kind: "synced", text: "[00:01.00]x" }, /synced/],
    [{ kind: "plain", text: PLAIN, local: true }, /Already has lyrics/],
  ]) {
    const host = fakeHost({ lyrics, tracks: VIDEO, segments: SPEECH });
    const p = await start(host);
    await transcribeById(host, 9);
    assert.equal(host.calls.exec.length, 0);
    assert.equal(host.calls.saves.length, 0);
    assert.match(host.store.get("recent")[0].detail, re);
    p.deactivate();
  }
});

test("a skipped transcription doesn't stop automatic syncing of that song later", async () => {
  const host = fakeHost({ tracks: VIDEO, segments: SPEECH });
  const p = await start(host);
  await transcribeById(host, 9);
  assert.equal(host.store.get("recent")[0].status, "skipped");
  assert.deepEqual(host.store.get("songStatus"), {});
  p.deactivate();
});

test("a transcript with no speech saves nothing", async () => {
  const host = fakeHost({ lyrics: null, tracks: VIDEO, segments: [[0, 30, "[Music]"]] });
  const p = await start(host);
  await transcribeById(host, 9);
  assert.equal(host.calls.saves.length, 0);
  assert.match(host.store.get("recent")[0].detail, /no speech/);
  p.deactivate();
});

test("lyrics that appear while transcribing are not overwritten", async () => {
  const host = fakeHost({ lyrics: null, tracks: VIDEO, segments: SPEECH });
  const realExec = host.api.system.exec;
  host.api.system.exec = async (program, args, o) => {
    const r = await realExec(program, args, o);
    if (program === "whisper-cli") host.setLyrics({ kind: "plain", text: "typed in meanwhile" });
    return r;
  };
  const p = await start(host);
  await transcribeById(host, 9);
  assert.equal(host.calls.saves.length, 0);
  assert.match(host.store.get("recent")[0].detail, /changed while transcribing/);
  p.deactivate();
});

test("automatic mode never transcribes", async () => {
  const host = fakeHost({ lyrics: null, segments: SPEECH });
  const p = await start(host);
  host.handlers.ui["set-auto"]({ value: true });
  const t = { key: "q:1", title: "Harbour", artist_name: "Glass Harbour", duration_secs: 200, path: "file:///music/harbour.flac" };
  host.setCurrent(t);
  const realSetTimeout = global.setTimeout;
  global.setTimeout = (fn) => realSetTimeout(fn, 0);
  try { host.handlers.trackStarted(t); } finally { global.setTimeout = realSetTimeout; }
  for (let i = 0; i < 50 && !host.store.get("recent")?.length; i++) await settle();
  assert.equal(host.calls.saves.length, 0);
  assert.equal(host.calls.exec.length, 0);
  assert.equal(host.store.get("recent")[0].mode, "sync");
  p.deactivate();
});

test("the transcribe assistant tool finds the library track and returns the outcome", async () => {
  const host = fakeHost({ lyrics: null, tracks: VIDEO, segments: SPEECH });
  const p = await start(host);
  const r = await host.handlers.tools.transcribe({ title: "Talk 2", artistName: "Harbour Talks" });
  assert.equal(r.status, "saved");
  assert.equal(r.lines, 2);
  await assert.rejects(() => host.handlers.tools.transcribe({ title: "Nope" }), /No library track/);
  p.deactivate();
});

// ------------------------------------------------------------ host contract

test("every program gets string arguments — temp files that don't exist yet included", async () => {
  for (const [opts, run] of [
    [{}, (host) => syncById(host, 7)],
    [{ lyrics: null, tracks: VIDEO, segments: SPEECH }, (host) => transcribeById(host, 9)],
  ]) {
    const host = fakeHost(opts);
    const p = await start(host);
    await run(host);
    assert.ok(host.calls.exec.length >= 2, "ffmpeg and whisper-cli ran");
    for (const c of host.calls.exec) {
      for (const a of c.args) assert.equal(typeof a, "string", c.program + " got " + a);
    }
    const ffmpeg = host.calls.exec.find((c) => c.program === "ffmpeg").args;
    assert.match(ffmpeg.at(-1), /^\/store\/tmp\/job-\d+\.wav$/);
    assert.equal(host.store.get("recent")[0].status, "saved");
    p.deactivate();
  }
});

test("a job the user asked for says it started, with a way to its progress", async () => {
  const host = fakeHost({ lyrics: null, tracks: VIDEO, segments: SPEECH });
  const p = await start(host);
  await transcribeById(host, 9);
  const started = host.calls.notes.find((n) => /^Transcribing Talk 2/.test(n.message));
  assert.ok(started, "start notice shown");
  assert.deepEqual(started.action, { label: "Show progress", id: "show-progress" });
  host.handlers.ui["show-progress"]();
  assert.deepEqual(host.calls.requests.at(-1), { action: "open-extension-settings", payload: {} });
  p.deactivate();
});

test("a job turned down before any work shows no start notice", async () => {
  const host = fakeHost({ lyrics: { kind: "synced", text: "[00:01.00]x" }, tracks: VIDEO });
  const p = await start(host);
  await transcribeById(host, 9);
  assert.equal(host.calls.notes.filter((n) => /^Transcribing/.test(n.message)).length, 0);
  assert.match(host.calls.notes.at(-1).message, /^Didn't transcribe/);
  p.deactivate();
});
