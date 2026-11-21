// The plugin's job logic against a fake host API: what it saves, what it
// drafts for review, what it skips, what it tells the user. Loads the built
// index.js the way the host's loader does (a function body taking `api`,
// returning { activate, deactivate }).
const { test } = require("node:test");
const assert = require("node:assert");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const CODE = readFileSync(join(__dirname, "..", "index.js"), "utf8");

const PLAIN = "Paper boats along the river\nCarry every word I never said";
const TRANSCRIPT_LINES = [[10, "Paper boats along the river"], [13, "Carry every word I never said"]];
const TIMED = "[00:09.75]Paper boats along the river\n[00:12.75]Carry every word I never said";

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
  const store = new Map(Object.entries(opts.store || {}));
  const handlers = { menu: {}, ui: {}, tools: {}, trackStarted: null, lyricsChanged: null };
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
      fetch: async () => {
        calls.fetches++;
        if (lyrics === "error") return { status: "error" };
        return lyrics ? { status: "ok", value: lyrics } : { status: "not_found" };
      },
    },
    lyrics: {
      save: async (track, l) => { calls.saves.push({ track, l }); return { savedTo: "app" }; },
      onChanged: (h) => { handlers.lyricsChanged = h; return () => {}; },
    },
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

// A job finished: it left a draft or a Recent entry.
async function finished(host, n = 1) {
  const count = () => (host.store.get("recent")?.length || 0) + (host.store.get("drafts")?.length || 0);
  for (let i = 0; i < 100 && count() < n; i++) await settle();
}

async function menu(host, item, id) {
  host.handlers.menu[item]({ kind: "track", trackId: id });
  await finished(host);
}
const syncById = (host, id) => menu(host, "sync-lyrics", id);
const transcribeById = (host, id) => menu(host, "transcribe", id);

const drafts = (host) => host.store.get("drafts") || [];
const recent = (host) => host.store.get("recent") || [];
const whisperArgs = (host) => host.calls.exec.find((c) => c.program === "whisper-cli").args;
const noTempFiles = (host) => assert.ok(![...host.files.keys()].some((k) => k.startsWith("tmp/job-")), "temp files removed");

// ------------------------------------------------------------ menu → draft

test("the menu times plain lyrics into a draft for review, and saves nothing", async () => {
  const host = fakeHost();
  const p = await start(host);
  await syncById(host, 7);
  assert.equal(host.calls.saves.length, 0, "nothing saved before review");
  const [d] = drafts(host);
  assert.equal(d.work, "sync");
  assert.equal(d.text, TIMED);
  assert.equal(d.title, "Harbour");
  assert.match(d.note, /Every line matched/);
  const args = whisperArgs(host);
  for (const flag of ["-nfa", "-ojf", "-pp"]) assert.ok(args.includes(flag), flag);
  assert.equal(args[args.indexOf("-dtw") + 1], "large.v3.turbo");
  assert.match(args[args.indexOf("--prompt") + 1], /^Paper boats along the river Carry/);
  const note = host.calls.notes.at(-1);
  assert.match(note.message, /^Timed lyrics for Harbour — Glass Harbour are ready to review/);
  assert.equal(note.kind, "success");
  assert.deepEqual(note.action, { label: "Review", id: "review-next" });
  assert.equal(recent(host).length, 0, "a draft isn't an outcome yet");
  noTempFiles(host);
  p.deactivate();
});

test("Review opens the draft in the app's lyrics editor", async () => {
  const host = fakeHost();
  const p = await start(host);
  await syncById(host, 7);
  host.handlers.ui["review-next"]();
  const req = host.calls.requests.at(-1);
  assert.equal(req.action, "review-lyrics");
  assert.deepEqual(req.payload, { title: "Harbour", artistName: "Glass Harbour", albumTitle: "Tides", text: TIMED, note: drafts(host)[0].note, source: "Whisper" });
  // The panel's row does the same.
  const row = host.calls.lastView.children.find((c) => c.title === "Ready to review").children[0].items[0];
  assert.deepEqual(row.badge, { label: "To review", variant: "accent" });
  assert.deepEqual(row.actions, ["review-draft", "discard-draft"]);
  assert.equal(row.action, "review-draft", "double-click reviews");
  host.handlers.ui["review-draft"]({ itemId: row.id });
  assert.equal(host.calls.requests.at(-1).action, "review-lyrics");
  p.deactivate();
});

const TWO = {
  7: { id: 7, title: "Harbour", artist_name: "Glass Harbour", duration_secs: 200, path: "file:///music/harbour.flac" },
  8: { id: 8, title: "Tide", artist_name: "Glass Harbour", duration_secs: 200, path: "file:///music/tide.flac" },
};

test("the app saying the review was saved ends the draft", async () => {
  const host = fakeHost({ tracks: TWO });
  const p = await start(host);
  host.handlers.menu["sync-lyrics"]({ kind: "multi-track", trackIds: [7, 8] });
  await finished(host, 2);
  assert.equal(drafts(host).length, 2);

  host.handlers.ui["review-lyrics:closed"]({ title: "Harbour", artistName: "Glass Harbour", outcome: "saved" });
  assert.deepEqual(drafts(host).map((d) => d.title), ["Tide"]);
  assert.equal(recent(host)[0].status, "saved");
  assert.equal(recent(host)[0].detail, "Saved after review");
  const next = host.calls.notes.at(-1);
  assert.match(next.message, /^Saved\. 1 more draft to review\./);
  assert.deepEqual(next.action, { label: "Review next", id: "review-next" });
  p.deactivate();
});

test("a discard in the app's editor ends the draft too, and frees the song for automatic syncing", async () => {
  const host = fakeHost();
  const p = await start(host);
  await syncById(host, 7);
  host.handlers.ui["review-lyrics:closed"]({ title: "Harbour", artistName: "Glass Harbour", outcome: "discarded" });
  assert.equal(drafts(host).length, 0);
  assert.equal(recent(host)[0].status, "discarded");
  assert.equal(host.calls.saves.length, 0);
  p.deactivate();
});

test("an edit of the song's lyrics outside the review doesn't end its draft", async () => {
  const host = fakeHost();
  const p = await start(host);
  await syncById(host, 7);
  // The plugin no longer reads lyric saves to guess approvals.
  if (host.handlers.lyricsChanged) host.handlers.lyricsChanged({ title: "Harbour", artistName: "Glass Harbour", origin: "edit" });
  assert.equal(drafts(host).length, 1);
  p.deactivate();
});

test("Discard drops a draft and leaves the lyrics alone", async () => {
  const host = fakeHost();
  const p = await start(host);
  await syncById(host, 7);
  host.handlers.ui["discard-draft"]({ itemId: drafts(host)[0].id });
  assert.equal(drafts(host).length, 0);
  assert.equal(host.calls.saves.length, 0);
  assert.equal(recent(host)[0].status, "discarded");
  assert.ok(!host.calls.lastView.children.some((c) => c.title === "Ready to review"));
  p.deactivate();
});

test("bad synced lyrics are re-timed: the same words, new times", async () => {
  const host = fakeHost({ lyrics: { kind: "synced", text: "[ar:Glass Harbour]\n[00:30.00]Paper boats along the river\n[00:31.00]Carry every word I never said\n[00:40.00]" } });
  const p = await start(host);
  await syncById(host, 7);
  const [d] = drafts(host);
  assert.equal(d.work, "resync");
  assert.equal(d.text, TIMED);
  assert.match(d.note, /^The song's lyrics, timed again\./);
  assert.match(whisperArgs(host)[whisperArgs(host).indexOf("--prompt") + 1], /^Paper boats along the river Carry/, "the prompt is the words, no timestamps");
  assert.match(host.calls.notes.at(-1).message, /^New timings for Harbour/);
  p.deactivate();
});

test("lyrics from the song's own file can be timed from the menu: the review saves them back there", async () => {
  const host = fakeHost({ lyrics: { kind: "plain", text: PLAIN, local: true } });
  const p = await start(host);
  await syncById(host, 7);
  assert.equal(drafts(host)[0].work, "sync");
  p.deactivate();
});

test("a poor match is still a draft, flagged so the user checks it", async () => {
  const host = fakeHost({ transcript: [[10, "Paper boats somewhere else entirely sung here"]] });
  const p = await start(host);
  await syncById(host, 7);
  const [d] = drafts(host);
  assert.match(d.note, /^Only 50% of lines matched/);
  assert.match(d.note, /Transcribe with Whisper/);
  assert.equal(host.calls.notes.at(-1).kind, "warning");
  assert.match(host.calls.notes.at(-1).message, /check them carefully/);
  p.deactivate();
});

test("a draft names the lines it had to guess", async () => {
  const host = fakeHost({
    lyrics: { kind: "plain", text: "Paper boats along the river\nSomething never sung at all\nCarry every word I never said\nLanterns over quiet water\nPaper boats along the river" },
    transcript: [[10, "Paper boats along the river"], [20, "Carry every word I never said"], [25, "Lanterns over quiet water"], [30, "Paper boats along the river"]],
  });
  const p = await start(host);
  await syncById(host, 7);
  assert.match(drafts(host)[0].note, /^80% of lines matched what was sung\. One line was placed between their neighbours, so check it: “Something never sung at all”\.$/);
  p.deactivate();
});

test("a new draft for a song replaces its older one", async () => {
  const host = fakeHost();
  const p = await start(host);
  await syncById(host, 7);
  const first = drafts(host)[0].id;
  host.handlers.menu["transcribe"]({ kind: "track", trackId: 7 });
  for (let i = 0; i < 100 && drafts(host)[0].id === first; i++) await settle();
  assert.equal(drafts(host).length, 1);
  assert.equal(drafts(host)[0].work, "transcribe");
  p.deactivate();
});

// ------------------------------------------------------------ transcription

const VIDEO = { 9: { id: 9, title: "Talk 2", artist_name: "Harbour Talks", duration_secs: 600, path: "file:///videos/talk2.mp4", kind: "video" } };
const SPEECH = [[2, 5, "Welcome to the harbour."], [5.5, 8, "Today we talk about boats."]];

test("Sync on a track with no lyrics transcribes it, as a draft", async () => {
  const host = fakeHost({ lyrics: null, segments: [[2, 5, "Paper boats along the river"]] });
  const p = await start(host);
  await syncById(host, 7);
  assert.equal(host.calls.saves.length, 0);
  assert.equal(drafts(host)[0].work, "transcribe");
  const args = whisperArgs(host);
  assert.ok(args.includes("-sow") && !args.includes("-dtw"), "transcription arguments");
  assert.match(host.calls.notes.at(-1).message, /^The transcript of Harbour — Glass Harbour is ready to review/);
  p.deactivate();
});

test("a video's transcript is a draft of its subtitles", async () => {
  const host = fakeHost({ lyrics: null, tracks: VIDEO, segments: SPEECH });
  const p = await start(host);
  await transcribeById(host, 9);
  assert.equal(host.calls.saves.length, 0);
  const [d] = drafts(host);
  assert.equal(d.text, "[00:02.00]Welcome to the harbour.\n[00:05.50]Today we talk about boats.\n[00:08.00]\n[10:00.00]");
  assert.equal(d.detail, "2 lines");
  assert.match(d.note, /video's subtitles/);
  const args = whisperArgs(host);
  assert.equal(args[args.indexOf("-ml") + 1], "84");
  for (const flag of ["-sow", "-ojf"]) assert.ok(args.includes(flag), flag);
  for (const flag of ["-dtw", "--prompt"]) assert.ok(!args.includes(flag), flag + " is for timing only");
  noTempFiles(host);
  p.deactivate();
});

test("Transcribe works over lyrics a track already has: the review decides", async () => {
  for (const lyrics of [{ kind: "plain", text: PLAIN }, { kind: "synced", text: "[00:01.00]x" }, "error"]) {
    const host = fakeHost({ lyrics, tracks: VIDEO, segments: SPEECH });
    const p = await start(host);
    await transcribeById(host, 9);
    assert.equal(drafts(host)[0]?.work, "transcribe", JSON.stringify(lyrics));
    assert.equal(host.calls.saves.length, 0);
    p.deactivate();
  }
});

test("a transcript with no speech makes no draft", async () => {
  const host = fakeHost({ lyrics: null, tracks: VIDEO, segments: [[0, 30, "[Music]"]] });
  const p = await start(host);
  await transcribeById(host, 9);
  assert.equal(drafts(host).length, 0);
  assert.match(recent(host)[0].detail, /no speech/);
  p.deactivate();
});

// ------------------------------------------------------------ what stops a job

test("a lyrics provider failure is not 'no lyrics': Sync transcribes nothing", async () => {
  const host = fakeHost({ lyrics: "error", segments: [[2, 5, "Paper boats"]] });
  const p = await start(host);
  await syncById(host, 7);
  assert.equal(host.calls.exec.length, 0);
  assert.equal(drafts(host).length, 0);
  assert.equal(recent(host)[0].status, "failed");
  assert.match(recent(host)[0].detail, /Couldn't read the track's lyrics/);
  p.deactivate();
});

test("a track that isn't a local file is skipped, with no start notice", async () => {
  const host = fakeHost({ tracks: { 7: { id: 7, title: "Harbour", artist_name: "X", duration_secs: 200, path: "subsonic://1/abc" } } });
  const p = await start(host);
  await syncById(host, 7);
  assert.equal(host.calls.exec.length, 0);
  assert.equal(recent(host)[0].detail, "Not a local file");
  assert.equal(host.calls.notes.filter((n) => /…$/.test(n.message)).length, 0);
  assert.equal(host.calls.notes.at(-1).message, "Didn't time the lyrics of Harbour — X: Not a local file");
  p.deactivate();
});

test("a missing model or whisper-cli: the menu says what to set up, once, and queues nothing", async () => {
  for (const [opts, re] of [[{ files: {} }, /model/], [{ whisperMissing: true }, /whisper-cli/]]) {
    const host = fakeHost(opts);
    const p = await start(host);
    host.handlers.menu["sync-lyrics"]({ kind: "multi-track", trackIds: [7, 7] });
    await settle();
    assert.equal(host.calls.exec.length, 0);
    assert.equal(host.calls.fetches, 0, "no job started");
    assert.equal(host.calls.notes.length, 1);
    assert.match(host.calls.notes[0].message, re);
    assert.equal(host.calls.notes[0].kind, "warning");
    assert.deepEqual(host.calls.notes[0].action, { label: "Set up", id: "show-progress" });
    p.deactivate();
  }
});

test("a whisper failure is reported and temp files are still removed", async () => {
  const host = fakeHost({ whisperFails: true });
  const p = await start(host);
  await syncById(host, 7);
  assert.equal(recent(host)[0].status, "failed");
  assert.match(recent(host)[0].detail, /failed to read audio/);
  assert.equal(host.calls.notes.at(-1).kind, "error");
  noTempFiles(host);
  p.deactivate();
});

// ------------------------------------------------------------ direct saves (no one to review)

test("the sync_lyrics tool saves plain lyrics that matched well, without review", async () => {
  const host = fakeHost();
  const p = await start(host);
  const r = await host.handlers.tools.sync_lyrics({ title: "Harbour", artistName: "Glass Harbour" });
  assert.equal(r.status, "saved");
  assert.equal(host.calls.saves.length, 1);
  assert.deepEqual(host.calls.saves[0].track, { title: "Harbour", artistName: "Glass Harbour", albumTitle: "Tides" });
  assert.deepEqual(host.calls.saves[0].l, { text: TIMED, kind: "synced" });
  assert.equal(drafts(host).length, 0);
  assert.equal(host.calls.notes.at(-1).message, "Synced lyrics for Harbour — Glass Harbour");
  await assert.rejects(() => host.handlers.tools.sync_lyrics({}), /title is required/);
  p.deactivate();
});

test("a direct save keeps the old guards: nothing over synced, file or missing lyrics, nothing on a poor match", async () => {
  for (const [opts, status, re] of [
    [{ lyrics: null }, "skipped", /No lyrics to time/],
    [{ lyrics: { kind: "synced", text: "[00:01.00]x" } }, "skipped", /Already synced/],
    [{ lyrics: { kind: "plain", text: PLAIN, local: true } }, "skipped", /song's file/],
    [{ transcript: [[10, "something else entirely sung here"]] }, "low-confidence", /% of lines matched/],
  ]) {
    const host = fakeHost(opts);
    const p = await start(host);
    const r = await host.handlers.tools.sync_lyrics({ title: "Harbour" });
    assert.equal(r.status, status);
    assert.match(r.detail, re);
    assert.equal(host.calls.saves.length, 0);
    assert.equal(drafts(host).length, 0);
    p.deactivate();
  }
});

test("a direct save doesn't overwrite lyrics that changed while whisper ran", async () => {
  const host = fakeHost();
  const realExec = host.api.system.exec;
  host.api.system.exec = async (program, args, o) => {
    const r = await realExec(program, args, o);
    if (program === "whisper-cli") host.setLyrics({ kind: "synced", text: "[00:01.00]edited by hand" });
    return r;
  };
  const p = await start(host);
  const r = await host.handlers.tools.sync_lyrics({ title: "Harbour" });
  assert.equal(host.calls.saves.length, 0);
  assert.match(r.detail, /changed while/);
  p.deactivate();
});

test("the transcribe tool makes a draft, only for a track with no lyrics", async () => {
  const host = fakeHost({ lyrics: null, tracks: VIDEO, segments: SPEECH });
  const p = await start(host);
  const r = await host.handlers.tools.transcribe({ title: "Talk 2", artistName: "Harbour Talks" });
  assert.equal(r.status, "draft");
  assert.equal(r.lines, 2);
  assert.match(r.note, /Ready to review/);
  assert.equal(host.calls.saves.length, 0);
  assert.equal(drafts(host).length, 1);
  await assert.rejects(() => host.handlers.tools.transcribe({ title: "Nope" }), /No library track/);

  for (const [lyrics, re] of [[{ kind: "plain", text: PLAIN }, /Sync lyrics with Whisper/], [{ kind: "synced", text: "[00:01.00]x" }, /synced/]]) {
    const h = fakeHost({ lyrics, tracks: VIDEO, segments: SPEECH });
    const q = await start(h);
    const s = await h.handlers.tools.transcribe({ title: "Talk 2" });
    assert.equal(s.status, "skipped");
    assert.match(s.detail, re);
    assert.equal(h.calls.exec.length, 0);
    q.deactivate();
  }
  p.deactivate();
});

// ------------------------------------------------------------ automatic mode

function autoStart(host, t) {
  const realSetTimeout = global.setTimeout;
  global.setTimeout = (fn) => realSetTimeout(fn, 0);
  try { host.handlers.trackStarted(t); } finally { global.setTimeout = realSetTimeout; }
}

const PLAYING = { key: "q:1", title: "Harbour", artist_name: "Glass Harbour", duration_secs: 200, path: "file:///music/harbour.flac" };

test("automatic mode is off by default: a started song does nothing", async () => {
  const host = fakeHost();
  const p = await start(host);
  host.setCurrent(PLAYING);
  host.handlers.trackStarted(PLAYING);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(host.calls.fetches, 0);
  p.deactivate();
});

test("automatic mode saves plain lyrics directly and never transcribes", async () => {
  for (const [lyrics, saved] of [[{ kind: "plain", text: PLAIN }, 1], [null, 0]]) {
    const host = fakeHost({ lyrics, segments: lyrics ? undefined : SPEECH });
    const p = await start(host);
    host.handlers.ui["set-auto"]({ value: true });
    host.setCurrent(PLAYING);
    autoStart(host, PLAYING);
    await finished(host);
    assert.equal(host.calls.saves.length, saved);
    assert.equal(drafts(host).length, 0);
    if (!lyrics) assert.equal(host.calls.exec.length, 0);
    p.deactivate();
  }
});

test("automatic mode leaves a song alone while its draft waits for review", async () => {
  const host = fakeHost({ store: { drafts: [{ id: "d1", title: "Harbour", artist: "Glass Harbour", work: "sync", text: TIMED, at: 1 }] } });
  const p = await start(host);
  host.handlers.ui["set-auto"]({ value: true });
  host.setCurrent(PLAYING);
  autoStart(host, PLAYING);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(host.calls.fetches, 0);
  p.deactivate();
});

// ------------------------------------------------------------ setup panel

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
    assert.equal(drafts(host).length, 1);
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
  assert.deepEqual(host.calls.requests.at(-1), { action: "open-extension-settings", payload: { section: "configuration" } });
  p.deactivate();
});

// ------------------------------------------------------------ batches + panel

const THREE = {
  1: { id: 1, title: "Harbour", artist_name: "Glass Harbour", duration_secs: 200, path: "file:///music/1.flac" },
  2: { id: 2, title: "Tide", artist_name: "Glass Harbour", duration_secs: 200, path: "file:///music/2.flac" },
  3: { id: 3, title: "Pier", artist_name: "Glass Harbour", duration_secs: 200, path: "subsonic://1/x" },
};

test("several tracks are one request: one start notice, one summary, no per-track toasts", async () => {
  const host = fakeHost({ tracks: THREE });
  const p = await start(host);
  host.handlers.menu["sync-lyrics"]({ kind: "multi-track", trackIds: [1, 2, 3] });
  await finished(host, 3);
  await settle();
  const msgs = host.calls.notes.map((n) => n.message);
  assert.deepEqual(msgs, ["Whisper is working on 3 tracks…", "Finished 3 tracks: 2 ready to review, 1 skipped."]);
  assert.deepEqual(host.calls.notes[0].action, { label: "Show progress", id: "show-progress" });
  assert.equal(host.calls.notes[1].kind, "success");
  assert.deepEqual(host.calls.notes[1].action, { label: "Review", id: "review-next" });
  // Worked through in the order asked for (newest first in each list).
  assert.deepEqual(drafts(host).map((d) => d.title), ["Tide", "Harbour"]);
  p.deactivate();
});

test("the panel shows the running job first, with its step, a bar and Cancel; waiting ones below", async () => {
  const host = fakeHost({ tracks: THREE });
  let release = null;
  const realExec = host.api.system.exec;
  host.api.system.exec = async (program, args, o) => {
    if (program !== "whisper-cli") return realExec(program, args, o);
    const wait = new Promise((r) => { release = r; });
    o.onStart({ cancel: async () => { release(); return true; } });
    o.onOutput("whisper_print_progress_callback: progress =  40%", "stderr");
    await wait;
    throw new Error("Cancelled");
  };
  const p = await start(host);
  host.handlers.menu["sync-lyrics"]({ kind: "multi-track", trackIds: [1, 2] });
  for (let i = 0; i < 50 && !release; i++) await settle();
  const working = host.calls.lastView.children[1];
  assert.equal(working.title, "Working", "the work comes right after the intro");
  const [list, toolbar] = working.children;
  assert.equal(list.type, "track-row-list");
  const [run, wait] = list.items;
  assert.equal(run.title, "Harbour");
  assert.deepEqual(run.badge, { label: "Syncing", variant: "accent", pulse: true });
  assert.equal(run.progress, 0.4);
  assert.match(run.subtitle, /^Glass Harbour · Listening · 40% · 0:0\d$/);
  assert.deepEqual(run.actions, ["cancel-job"]);
  assert.equal(run.action, "open-track", "double-click opens the track, never cancels");
  assert.deepEqual(wait.badge, { label: "Waiting", variant: "muted" });
  assert.equal(toolbar.status, "1 waiting");

  // Cancel the waiting one, then the running one.
  host.handlers.ui["cancel-job"]({ itemId: wait.id });
  assert.equal(host.calls.lastView.children[1].children[0].items.length, 1);
  host.handlers.ui["cancel-job"]({ itemId: run.id });
  await finished(host, 2);
  await settle();
  assert.deepEqual(recent(host).map((r) => r.status), ["cancelled", "cancelled"]);
  assert.deepEqual(host.store.get("songStatus"), {}, "a cancel isn't 'tried before'");
  assert.equal(host.calls.notes.filter((n) => /^Finished/.test(n.message)).length, 0, "nothing to report when all of it was cancelled");
  assert.ok(!host.calls.lastView.children.some((c) => c.title === "Working"));
  const rows = host.calls.lastView.children.find((c) => c.title === "Recent").children[0].items;
  assert.deepEqual(rows[0].badge, { label: "Cancelled", variant: "muted" });
  assert.deepEqual(rows[0].actions, ["retry"]);
  p.deactivate();
});

test("Recent shows each outcome as a chip", async () => {
  const host = fakeHost();
  const p = await start(host);
  await host.handlers.tools.sync_lyrics({ title: "Harbour" });
  const rows = host.calls.lastView.children.find((c) => c.title === "Recent").children[0].items;
  assert.deepEqual(rows[0].badge, { label: "Synced", variant: "success" });
  assert.match(rows[0].subtitle, /^Glass Harbour · 100% of lines matched · just now$/);
  assert.deepEqual(rows[0].actions, []);
  p.deactivate();
});

// ------------------------------------------------------------ review findings

test("Try again after Cancel all acts on the row it was pressed on", async () => {
  const host = fakeHost({ tracks: THREE });
  let release = null;
  const realExec = host.api.system.exec;
  host.api.system.exec = async (program, args, o) => {
    if (program !== "whisper-cli") return realExec(program, args, o);
    const wait = new Promise((r) => { release = r; });
    o.onStart({ cancel: async () => { release(); return true; } });
    await wait;
    throw new Error("Cancelled");
  };
  const p = await start(host);
  host.handlers.menu["sync-lyrics"]({ kind: "multi-track", trackIds: [1, 2, 3] });
  for (let i = 0; i < 50 && !release; i++) await settle();
  host.handlers.ui["cancel-all"]();
  await finished(host, 3);
  const rows = host.calls.lastView.children.find((c) => c.title === "Recent").children[0].items;
  assert.equal(new Set(rows.map((r) => r.id)).size, rows.length, "every row has its own id");
  const target = rows.find((r) => r.title === "Tide");
  host.handlers.ui["open-track"]({ itemId: target.id });
  assert.equal(host.calls.requests.at(-1).payload.name, "Tide");
  p.deactivate();
});

test("a direct save skips videos and clips under a minute", async () => {
  for (const [track, re] of [
    [{ id: 7, title: "Harbour", artist_name: "Glass Harbour", duration_secs: 200, path: "file:///v/harbour.mp4", kind: "video" }, /A video/],
    [{ id: 7, title: "Harbour", artist_name: "Glass Harbour", duration_secs: 40, path: "file:///m/harbour.flac" }, /Shorter than a minute/],
  ]) {
    const host = fakeHost({ tracks: { 7: track } });
    const p = await start(host);
    const r = await host.handlers.tools.sync_lyrics({ title: "Harbour" });
    assert.equal(r.status, "skipped");
    assert.match(r.detail, re);
    assert.equal(host.calls.exec.length, 0);
    assert.equal(host.calls.saves.length, 0);
    p.deactivate();
  }
});

test("Cancel pressed as Whisper finishes leaves no draft", async () => {
  const host = fakeHost();
  const realRead = host.api.storage.files.readJson;
  host.api.storage.files.readJson = async (path) => {
    const v = await realRead(path);
    host.handlers.ui["cancel-job"]({ itemId: host.calls.lastView.children[1].children[0].items[0].id });
    return v;
  };
  const p = await start(host);
  await syncById(host, 7);
  assert.equal(drafts(host).length, 0);
  assert.equal(recent(host)[0].status, "cancelled");
  assert.ok(!host.calls.notes.some((n) => /ready to review/.test(n.message)));
  p.deactivate();
});

test("the transcribe tool says the lyrics couldn't be read, not that there are some", async () => {
  const host = fakeHost({ lyrics: "error", tracks: VIDEO, segments: SPEECH });
  const p = await start(host);
  const r = await host.handlers.tools.transcribe({ title: "Talk 2" });
  assert.equal(r.status, "failed");
  assert.match(r.detail, /Couldn't read the track's lyrics/);
  p.deactivate();
});

test("a menu item on a track that isn't in the library says so", async () => {
  const host = fakeHost();
  const p = await start(host);
  host.handlers.menu["sync-lyrics"]({ kind: "track", title: "Not here", artistName: "Nobody" });
  await settle();
  assert.equal(host.calls.notes.at(-1).message, "Whisper works on tracks in your library, and this one isn't.");
  assert.equal(host.calls.exec.length, 0);
  p.deactivate();
});

test("re-timing keeps a chorus that was stamped twice", async () => {
  const host = fakeHost({
    lyrics: { kind: "synced", text: "[00:10.00]Paper boats along the river\n[00:20.00][00:40.00]Carry every word I never said\n[00:30.00]Lanterns over quiet water" },
    transcript: [[10, "Paper boats along the river"], [20, "Carry every word I never said"], [30, "Lanterns over quiet water"], [40, "Carry every word I never said"]],
  });
  const p = await start(host);
  await syncById(host, 7);
  const lines = drafts(host)[0].text.split("\n").map((l) => l.replace(/^\[[^\]]+\]/, ""));
  assert.deepEqual(lines, ["Paper boats along the river", "Carry every word I never said", "Lanterns over quiet water", "Carry every word I never said"]);
  p.deactivate();
});
