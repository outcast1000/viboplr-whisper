// Whisper: time a song's plain lyrics from its audio, or transcribe a track
// that has no lyrics at all.
//
// scripts/build.mjs joins align.js (as `WhisperAlign`) and this file into
// index.js, the one file the plugin loader reads. Edit these two, never
// index.js.
//
// Two kinds of job, for one track each:
//   sync        lyrics plain? → ffmpeg: 16 kHz mono WAV → whisper-cli (DTW
//               token times, the lyrics as prompt) → align → save as synced,
//               if enough lines anchored. Never writes lyrics a song doesn't
//               have. The only kind automatic mode runs.
//   transcribe  no lyrics at all? → ffmpeg → whisper-cli (subtitle-sized
//               segments) → timed lines → save as synced. Only on the user's
//               own ask (the menu item or the assistant tool), never
//               automatically, never over lyrics the track already has. For a
//               video, synced lyrics are its subtitles.
// Local files only.

var Align = WhisperAlign;

var PANEL = "whisper-settings";
var MODELS_URL = "https://github.com/outcast1000/viboplr-whisper-cpp/releases/download/models-1/";
var MODELS = {
  turbo: {
    file: "ggml-large-v3-turbo-q5_0.bin",
    sha256: "394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2",
    sizeMb: 574,
    dtw: "large.v3.turbo",
    label: "Large v3 Turbo · 574 MB",
  },
  small: {
    file: "ggml-small-q5_1.bin",
    sha256: "ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb",
    sizeMb: 190,
    dtw: "small",
    label: "Small · 190 MB (faster, less accurate)",
  },
};
var LANGUAGES = [
  ["auto", "Detect from the audio"], ["el", "Greek"], ["en", "English"], ["de", "German"],
  ["es", "Spanish"], ["fr", "French"], ["it", "Italian"], ["pt", "Portuguese"],
  ["nl", "Dutch"], ["sv", "Swedish"], ["tr", "Turkish"], ["ru", "Russian"],
  ["ja", "Japanese"], ["ko", "Korean"], ["zh", "Chinese"],
];
var DEFAULT_SETTINGS = { auto: false, model: "turbo", language: "auto" };
// Share of lyric lines that must be anchored on a sung word before a result
// is saved. Below it, nothing is saved: wrong timings kept forever are worse
// than none.
var MIN_ANCHORED = 0.7;
var MIN_TRACK_SECS = 60;
var AUTO_DELAY_MS = 5000;
var MAX_QUEUE = 20;
var MAX_RECENT = 25;
var PROMPT_CHARS = 220;
// Longest transcribed line, in characters: two lines of a subtitle.
var SUBTITLE_CHARS = 84;

var api = null;
var settings = DEFAULT_SETTINGS;
var recent = [];        // [{ title, artist, status, detail, at }]
var songStatus = {};    // songKey → "saved" | "low-confidence" | "failed" | "skipped"
var queue = [];         // [{ song, manual, resolve }]
var current = null;     // { song, step, percent, handle }
var working = false;
var modelDownload = null; // { received, total }
var whisperStatus = null; // PluginDependencyStatus | null
var unsubs = [];
var timers = [];

// ---------------------------------------------------------------- helpers

function songKey(title, artist) {
  return Align.fold(title || "") + "|" + Align.fold(artist || "");
}

function describe(song) {
  return song.artistName ? song.title + " — " + song.artistName : song.title;
}

// "file:///Users/a/b.mp3" → "/Users/a/b.mp3"; "file:///C:/x.mp3" → "C:/x.mp3".
function localPath(path) {
  if (typeof path !== "string" || path.indexOf("file://") !== 0) return null;
  var p = path.slice("file://".length);
  if (/^\/[A-Za-z]:[\\/]/.test(p)) p = p.slice(1);
  return p;
}

function songFromTrack(t) {
  if (!t) return null;
  return {
    title: t.title,
    artistName: t.artist_name || null,
    albumTitle: t.album_title || null,
    durationSecs: typeof t.duration_secs === "number" ? t.duration_secs : null,
    path: localPath(t.path),
    trackId: typeof t.id === "number" ? t.id : null,
    video: t.kind === "video",
  };
}

function lastLines(text, n) {
  var lines = String(text || "").trim().split(/\r?\n/).filter(Boolean);
  return lines.slice(-n).join(" · ");
}

function log(level, message) {
  try { api.log(level, message); } catch (e) { /* logging must never break a job */ }
}

function notify(message, kind, action) {
  var opts = { kind: kind };
  if (action) opts.action = action;
  try { api.ui.showNotification(message, opts); } catch (e) { log("error", "notify failed: " + e); }
}

// A job the user asked for takes tens of seconds, and its progress is drawn
// only in this plugin's settings panel: say it started, with a way there.
function announceStart(song, mode) {
  notify((mode === "transcribe" ? "Transcribing " : "Syncing the lyrics of ") + describe(song) + "…", "info",
    { label: "Show progress", id: "show-progress" });
}

function save() {
  return Promise.all([
    api.storage.set("settings", settings),
    api.storage.set("recent", recent),
    api.storage.set("songStatus", songStatus),
  ]).catch(function (e) { log("error", "Saving state failed: " + e); });
}

// songStatus is what automatic syncing reads ("tried before"), so only sync
// outcomes go there: a transcription skipped for having plain lyrics must not
// stop those lyrics being timed later.
function record(song, mode, status, detail) {
  recent.unshift({ title: song.title, artist: song.artistName, mode: mode, status: status, detail: detail || "", at: Date.now() });
  if (recent.length > MAX_RECENT) recent.length = MAX_RECENT;
  if (mode === "sync") songStatus[songKey(song.title, song.artistName)] = status;
  save();
}

function model() {
  return MODELS[settings.model] || MODELS.turbo;
}

// ------------------------------------------------------------ lyrics check

function lyricsEntity(song) {
  var e = { kind: "track", name: song.title, id: song.trackId || 0 };
  if (song.artistName) e.artistName = song.artistName;
  if (song.albumTitle) e.albumTitle = song.albumTitle;
  if (song.path) e.path = "file://" + song.path;
  if (song.durationSecs) e.durationSecs = song.durationSecs;
  return e;
}

// → { state: "none" | "synced" | "plain" | "file", text? }
function readLyrics(song) {
  return api.informationTypes.fetch("lyrics", lyricsEntity(song)).then(function (r) {
    var v = r && r.status === "ok" ? r.value : null;
    var text = v && typeof v.text === "string" ? v.text.trim() : "";
    if (!text) return { state: "none" };
    if (v.kind === "synced") return { state: "synced" };
    // Lyrics read from the song's own file: a save to the app's cache would be
    // undone by the next daily re-read of the file. Saving into the file needs
    // the lyrics:files permission, which this version doesn't ask for.
    if (v.local) return { state: "file", text: text };
    return { state: "plain", text: text };
  });
}

// ------------------------------------------------------------ prerequisites

function refreshWhisperStatus() {
  return api.system.getDependency("whisper-cli").then(function (s) {
    whisperStatus = s;
    return s;
  }, function (e) {
    log("error", "Reading whisper-cli status failed: " + e);
    whisperStatus = null;
    return null;
  });
}

function modelPath() {
  var m = model();
  return api.storage.files.exists(["models", m.file]).then(function (ok) {
    return ok ? api.storage.files.getPath(["models", m.file]) : null;
  });
}

function downloadModel() {
  var m = model();
  if (modelDownload) return Promise.reject(new Error("A model is already downloading"));
  if (!(api.system.programs && typeof api.system.programs.download === "function")) {
    return Promise.reject(new Error("This version of Vibo can't download the model — update Vibo"));
  }
  modelDownload = { received: 0, total: m.sizeMb * 1024 * 1024 };
  render();
  var last = 0;
  return api.system.programs.download(["models", m.file], MODELS_URL + m.file, {
    sha256: m.sha256,
    maxBytes: 1024 * 1024 * 1024,
    label: "Whisper model " + m.label,
    onProgress: function (received, total) {
      modelDownload = { received: received, total: total || modelDownload.total };
      var now = Date.now();
      if (now - last > 500) { last = now; render(); }
    },
  }).then(function (r) {
    modelDownload = null;
    render();
    return r.path;
  }, function (e) {
    modelDownload = null;
    render();
    throw e;
  });
}

// ---------------------------------------------------------------- the job

// Absolute path for a temp file that doesn't exist yet. getPath answers only
// for files that exist (null otherwise), so ask for the .keep file and swap
// the name: asking for the .wav itself handed ffmpeg a null argument.
function tmpPath(name) {
  return api.storage.files.writeText(["tmp", ".keep"], "").then(function () {
    return api.storage.files.getPath(["tmp", ".keep"]);
  }).then(function (keep) {
    if (typeof keep !== "string" || !keep) throw new Error("Couldn't find the plugin's temp folder");
    var cut = Math.max(keep.lastIndexOf("/"), keep.lastIndexOf("\\"));
    return keep.slice(0, cut + 1) + name;
  });
}

function removeTmp(names) {
  return Promise.all(names.map(function (n) {
    return api.storage.files.remove(["tmp", n]).catch(function () { /* already gone */ });
  }));
}

function exec(program, args, onLine) {
  return api.system.exec(program, args, {
    onStart: function (handle) { if (current) current.handle = handle; },
    onOutput: onLine,
  }).then(function (r) {
    if (r.exitCode !== 0) throw new Error(program + " failed: " + (lastLines(r.stderr, 3) || "exit " + r.exitCode));
    return r;
  });
}

function setStep(step, percent) {
  if (!current) return;
  current.step = step;
  current.percent = percent == null ? null : percent;
  render();
}

function done(status, detail, extra) {
  var r = { status: status, detail: detail };
  if (extra) for (var k in extra) r[k] = extra[k];
  return r;
}

// Reasons to stop before reading anything; null to go on.
function precheck(song, mode) {
  if (!song.path) return done("skipped", "Not a local file");
  if (mode === "transcribe") return null;
  if (song.video) return done("skipped", "A video");
  if (song.durationSecs && song.durationSecs < MIN_TRACK_SECS) return done("skipped", "Shorter than a minute");
  return null;
}

// What the track's current lyrics allow; null to go on.
function lyricsCheck(l, mode) {
  if (mode === "transcribe") {
    if (l.state === "synced") return done("skipped", "Already has synced lyrics");
    if (l.state !== "none") return done("skipped", "Already has lyrics; \"Sync lyrics with Whisper\" times them");
    return null;
  }
  if (l.state === "none") return done("skipped", "No lyrics to time");
  if (l.state === "synced") return done("skipped", "Already synced");
  if (l.state === "file") return done("skipped", "Lyrics come from the song's file; saving into files isn't supported yet");
  return null;
}

function whisperArgs(mode, paths, lyrics) {
  var args = ["-m", paths.model, "-f", paths.wav, "-l", settings.language || "auto", "-ojf", "-of", paths.out, "-pp"];
  if (mode === "transcribe") return args.concat(["-ml", String(SUBTITLE_CHARS), "-sow"]);
  var prompt = lyrics.text.replace(/\s+/g, " ").slice(0, PROMPT_CHARS);
  return args.concat(["-nfa", "-dtw", model().dtw, "--prompt", prompt]);
}

// Transcript → { lrc?, result }: the synced text to save, if any.
function finish(song, mode, transcript, lyrics) {
  if (mode === "transcribe") {
    var t = Align.transcriptLrc(transcript, { durationSecs: song.durationSecs || undefined });
    if (!t.lines) return { result: done("skipped", "Whisper heard no speech") };
    return { lrc: t.lrc, result: done("saved", t.lines + " lines", { lines: t.lines }) };
  }
  var r = Align.alignLyrics(lyrics.text, transcript, { durationSecs: song.durationSecs || undefined });
  var pct = Math.round(r.anchoredRatio * 100);
  if (r.anchoredRatio < MIN_ANCHORED) {
    return { result: done("low-confidence", "Only " + pct + "% of lines matched what was sung", { ratio: r.anchoredRatio }) };
  }
  return { lrc: r.lrc, result: done("saved", pct + "% of lines matched", { ratio: r.anchoredRatio }) };
}

// → Promise<{ status, detail, ratio?, lines? }>; never rejects.
function runJob(song, mode) {
  var id = "job-" + Date.now();
  var wav = id + ".wav", out = id;
  var paths = {};
  var lyrics;

  var early = precheck(song, mode);
  if (early) return Promise.resolve(early);

  setStep("Checking lyrics");
  return readLyrics(song).then(function (l) {
    lyrics = l;
    var stop = lyricsCheck(l, mode);
    if (stop) return stop;
    return refreshWhisperStatus().then(function (s) {
      if (!s || !s.installed) return done("failed", "whisper-cli isn't installed", { needs: "whisper-cli" });
      return modelPath().then(function (mp) {
        if (!mp) return done("failed", "The Whisper model isn't downloaded", { needs: "model" });
        paths.model = mp;
        return Promise.all([tmpPath(wav), tmpPath(out)]).then(function (p) {
          paths.wav = p[0];
          paths.out = p[1];
          if (current && current.manual) announceStart(song, mode);
          setStep("Reading the audio");
          return exec("ffmpeg", ["-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i", song.path, "-vn", "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", paths.wav]);
        }).then(function () {
          setStep("Listening", 0);
          return exec("whisper-cli", whisperArgs(mode, paths, lyrics), function (line) {
            var m = /progress\s*=\s*(\d+)%/.exec(line);
            if (m) setStep("Listening", +m[1]);
          });
        }).then(function () {
          setStep(mode === "transcribe" ? "Writing the lines" : "Lining up the lyrics");
          return api.storage.files.readJson(["tmp", out + ".json"]);
        }).then(function (transcript) {
          var f = finish(song, mode, transcript, lyrics);
          if (!f.lrc) return f.result;
          // Read again: the user may have saved lyrics while this ran.
          return readLyrics(song).then(function (again) {
            if (again.state !== lyrics.state) {
              return done("skipped", "The lyrics changed while " + (mode === "transcribe" ? "transcribing" : "timing them"));
            }
            setStep("Saving");
            return api.lyrics.save(
              { title: song.title, artistName: song.artistName, albumTitle: song.albumTitle },
              { text: f.lrc, kind: "synced" },
            ).then(function () { return f.result; });
          });
        });
      });
    });
  }).catch(function (e) {
    var msg = e && e.message ? e.message : String(e);
    if (msg === "Cancelled") return done("cancelled", "Cancelled");
    log("error", (mode === "transcribe" ? "Transcribing " : "Syncing ") + describe(song) + " failed: " + msg);
    return done("failed", msg);
  }).then(function (result) {
    return removeTmp([wav, out + ".json"]).then(function () { return result; });
  });
}

// ---------------------------------------------------------------- the queue

function enqueue(song, manual, mode) {
  mode = mode || "sync";
  var key = songKey(song.title, song.artistName);
  var dup = (current && songKey(current.song.title, current.song.artistName) === key) ||
    queue.some(function (j) { return songKey(j.song.title, j.song.artistName) === key; });
  if (dup) return Promise.resolve({ status: "skipped", detail: "Already being worked on" });
  if (queue.length >= MAX_QUEUE) return Promise.resolve({ status: "skipped", detail: "Too many tracks waiting" });
  return new Promise(function (resolve) {
    var job = { song: song, manual: manual, mode: mode, resolve: resolve };
    // Newest first: what the user just asked for or just started playing.
    queue.unshift(job);
    render();
    pump();
  });
}

function pump() {
  if (working || !queue.length) return;
  working = true;
  var job = queue.shift();
  current = { song: job.song, mode: job.mode, manual: job.manual, step: "Starting", percent: null, handle: null };
  render();
  runJob(job.song, job.mode).then(function (result) {
    if (!api) { job.resolve(result); return; } // deactivated mid-job
    if (result.status !== "cancelled") record(job.song, job.mode, result.status, result.detail);
    announce(job, result);
    job.resolve(result);
  }).then(function () {
    current = null;
    working = false;
    if (!api) return;
    render();
    pump();
  });
}

function announce(job, result) {
  var name = describe(job.song);
  if (job.mode === "transcribe") {
    if (result.status === "saved") {
      notify("Transcribed " + name + " (" + result.detail + ")" + (job.song.video ? " — turn on subtitles to see them" : ""), "success");
    } else if (job.manual && result.status === "failed") {
      notify("Couldn't transcribe " + name + ": " + result.detail, "error");
    } else if (job.manual && result.status === "skipped") {
      notify("Didn't transcribe " + name + ": " + result.detail, "info");
    }
    return;
  }
  if (result.status === "saved") {
    notify("Synced lyrics for " + name, "success");
  } else if (job.manual && result.status === "low-confidence") {
    notify("Couldn't time the lyrics of " + name + " reliably — nothing was saved. " + result.detail + ".", "warning");
  } else if (job.manual && result.status === "failed") {
    notify("Couldn't sync the lyrics of " + name + ": " + result.detail, "error");
  } else if (job.manual && result.status === "skipped") {
    notify("Didn't sync " + name + ": " + result.detail, "info");
  }
}

// ------------------------------------------------------------- finding songs

function songFromTarget(target) {
  if (target && typeof target.trackId === "number") {
    return api.library.getTrackById(target.trackId).then(songFromTrack);
  }
  if (!target || !target.title) return Promise.resolve(null);
  return findLocal(target.title, target.artistName);
}

function findLocal(title, artistName) {
  if (typeof api.library.findTrack !== "function") return Promise.resolve(null);
  return api.library.findTrack({ title: title, artist: artistName || "" }).then(function (copies) {
    var list = Array.isArray(copies) ? copies : [];
    for (var i = 0; i < list.length; i++) if (localPath(list[i].path)) return songFromTrack(list[i]);
    return list.length ? songFromTrack(list[0]) : null;
  });
}

function syncTargets(targets, mode) {
  return Promise.all(targets.map(songFromTarget)).then(function (songs) {
    songs.forEach(function (song) { if (song) enqueue(song, true, mode); });
  });
}

function menuTargets(target) {
  return target && target.kind === "multi-track" && Array.isArray(target.trackIds)
    ? target.trackIds.map(function (id) { return { trackId: id }; })
    : [target];
}

// ------------------------------------------------------------------- auto

function onTrackStarted(track) {
  if (!settings.auto || !track) return;
  var song = songFromTrack(track);
  if (!song || !song.path || song.video) return;
  if (song.durationSecs && song.durationSecs < MIN_TRACK_SECS) return;
  if (songStatus[songKey(song.title, song.artistName)]) return; // tried before; the menu item retries
  var key = track.key;
  var t = setTimeout(function () {
    var now = api.playback.getCurrentTrack();
    if (!now || now.key !== key) return; // skipped already
    enqueue(song, false);
  }, AUTO_DELAY_MS);
  timers.push(t);
}

// ------------------------------------------------------------------ panel

function statusLabel(r) {
  if (r.mode === "transcribe") {
    return { saved: "Transcribed", failed: "Transcription failed", skipped: "Not transcribed" }[r.status] || r.status;
  }
  return { saved: "Saved", "low-confidence": "Not saved — low match", failed: "Failed", skipped: "Skipped" }[r.status] || r.status;
}

function render() {
  if (!api) return;
  var m = model();
  var children = [];

  children.push({ type: "text", content: "Adds timings to a song's plain lyrics by listening to the song with Whisper. A track with no lyrics at all (a talk, an interview, a video) can be transcribed instead: right-click it and choose \"Transcribe with Whisper\". For a video the transcript shows as its subtitles. Transcription only runs when you ask for it and never replaces lyrics a track already has. Local files only." });

  // whisper-cli
  var w = whisperStatus;
  children.push({
    type: "settings-row",
    label: "whisper-cli",
    description: w && w.installed ? "Installed" + (w.version ? " · " + w.version : "") : "Not installed. It's downloaded from github.com/outcast1000/viboplr-whisper-cpp.",
    control: w && w.installed ? undefined : { type: "toolbar", buttons: [{ label: "Install", action: "install-whisper", variant: "accent" }] },
  });

  // model: one row to choose it, plus a download row only while it's missing
  children.push({
    type: "select",
    label: "Model",
    description: render.modelReady ? "Downloaded" : modelDownload ? "Downloading…" : "Not downloaded yet",
    action: "set-model",
    value: settings.model,
    options: Object.keys(MODELS).map(function (k) { return { value: k, label: MODELS[k].label }; }),
  });
  if (modelDownload) {
    children.push({ type: "progress-bar", value: modelDownload.received, max: modelDownload.total || 1, label: "Downloading " + Math.round(modelDownload.received / 1048576) + " of " + Math.round((modelDownload.total || 0) / 1048576) + " MB" });
  } else if (!render.modelReady) {
    children.push({
      type: "settings-row",
      label: "Download the model",
      description: "Needed before Whisper can listen. From github.com/outcast1000/viboplr-whisper-cpp.",
      control: { type: "toolbar", buttons: [{ label: "Download (" + m.sizeMb + " MB)", action: "download-model", variant: "accent" }] },
    });
  }
  children.push({ type: "select", label: "Language", description: "Setting it helps when detection guesses wrong.", action: "set-language", value: settings.language, options: LANGUAGES.map(function (l) { return { value: l[0], label: l[1] }; }) });
  children.push({ type: "toggle", label: "Sync automatically", description: "When a song with plain lyrics starts playing, time its lyrics in the background. Each song is tried once; the menu item \"Sync lyrics with Whisper\" tries again.", action: "set-auto", checked: !!settings.auto });

  // now
  if (current) {
    var now = [{ type: "text", content: (current.mode === "transcribe" ? "Transcribing " : "Syncing ") + describe(current.song) + " — " + current.step + (current.percent != null ? " " + current.percent + "%" : "") + "…" }];
    if (current.percent != null) now.push({ type: "progress-bar", value: current.percent, max: 100 });
    now.push({ type: "toolbar", buttons: [{ label: "Cancel", action: "cancel-job", variant: "secondary" }], status: queue.length ? queue.length + " more waiting" : undefined });
    children.push({ type: "section", title: "Now", children: now });
  }

  children.push({
    type: "section",
    title: "Recent",
    children: recent.length
      ? recent.map(function (r) { return { type: "text", content: statusLabel(r) + " · " + (r.artist ? r.title + " — " + r.artist : r.title) + (r.detail ? " · " + r.detail : "") }; })
      : [{ type: "text", content: "Nothing yet. Right-click a song and choose \"Sync lyrics with Whisper\"." }],
  });

  api.ui.setViewData(PANEL, { type: "layout", direction: "vertical", children: children });
}
render.modelReady = false;

function refreshPanel() {
  return Promise.all([refreshWhisperStatus(), modelPath()]).then(function (r) {
    render.modelReady = !!r[1];
    render();
  }, function (e) { log("error", "Refreshing the panel failed: " + e); });
}

// --------------------------------------------------------------- activate

function activate(pluginApi) {
  api = pluginApi;
  Promise.all([api.storage.get("settings"), api.storage.get("recent"), api.storage.get("songStatus")]).then(function (v) {
    settings = Object.assign({}, DEFAULT_SETTINGS, v[0] || {});
    recent = Array.isArray(v[1]) ? v[1] : [];
    songStatus = v[2] && typeof v[2] === "object" ? v[2] : {};
    return refreshPanel();
  }).catch(function (e) { log("error", "Loading state failed: " + e); });

  unsubs.push(api.contextMenu.onAction("sync-lyrics", function (target) {
    syncTargets(menuTargets(target), "sync").catch(function (e) { notify("Couldn't sync lyrics: " + e, "error"); });
  }));
  unsubs.push(api.contextMenu.onAction("transcribe", function (target) {
    syncTargets(menuTargets(target), "transcribe").catch(function (e) { notify("Couldn't transcribe: " + e, "error"); });
  }));

  unsubs.push(api.ui.onAction("show-progress", function () {
    api.ui.requestAction("open-extension-settings", {});
  }));

  unsubs.push(api.playback.onTrackStarted(onTrackStarted));

  // Newer hosts say when whisper-cli finishes installing, whoever started it
  // (our Install button, Extensions → Tools, the update notice).
  var hearsInstalls = !!(api.system && typeof api.system.onDependencyInstalled === "function");
  if (hearsInstalls) {
    unsubs.push(api.system.onDependencyInstalled(function (change) {
      if (change && change.name === "whisper-cli") refreshPanel();
    }));
  }

  unsubs.push(api.ui.onAction("install-whisper", function () {
    api.ui.requestAction("require-dependency", { name: "whisper-cli", feature: "Sync lyrics with Whisper" });
    if (hearsInstalls) return;
    // Older hosts don't say when an install finishes; look again for a while.
    var tries = 0;
    var t = setInterval(function () {
      tries++;
      refreshPanel();
      if ((whisperStatus && whisperStatus.installed) || tries > 100) clearInterval(t);
    }, 3000);
    timers.push(t);
  }));
  unsubs.push(api.ui.onAction("download-model", function () {
    downloadModel().then(function () { return refreshPanel(); }, function (e) {
      var msg = e && e.message ? e.message : String(e);
      if (msg !== "Install declined") notify("Couldn't download the Whisper model: " + msg, "error");
    });
  }));
  unsubs.push(api.ui.onAction("set-model", function (p) {
    if (p && MODELS[p.value]) { settings.model = p.value; save(); refreshPanel(); }
  }));
  unsubs.push(api.ui.onAction("set-language", function (p) {
    if (p && typeof p.value === "string") { settings.language = p.value; save(); render(); }
  }));
  unsubs.push(api.ui.onAction("set-auto", function (p) {
    settings.auto = !!(p && p.value); save(); render();
  }));
  unsubs.push(api.ui.onAction("cancel-job", function () {
    if (current && current.handle) current.handle.cancel();
  }));

  if (api.assistant && typeof api.assistant.onTool === "function") {
    unsubs.push(api.assistant.onTool("sync_lyrics", function (args) {
      var title = args && typeof args.title === "string" ? args.title.trim() : "";
      var artist = args && typeof args.artistName === "string" ? args.artistName.trim() : "";
      if (!title) return Promise.reject(new Error("title is required"));
      return findLocal(title, artist).then(function (song) {
        if (!song) throw new Error("No library track matches \"" + title + "\"" + (artist ? " by " + artist : ""));
        return enqueue(song, false, "sync");
      });
    }));
    unsubs.push(api.assistant.onTool("transcribe", function (args) {
      var title = args && typeof args.title === "string" ? args.title.trim() : "";
      var artist = args && typeof args.artistName === "string" ? args.artistName.trim() : "";
      if (!title) return Promise.reject(new Error("title is required"));
      return findLocal(title, artist).then(function (song) {
        if (!song) throw new Error("No library track matches \"" + title + "\"" + (artist ? " by " + artist : ""));
        return enqueue(song, false, "transcribe");
      });
    }));
  }
}

function deactivate() {
  timers.forEach(function (t) { clearTimeout(t); clearInterval(t); });
  timers = [];
  unsubs.forEach(function (u) { try { if (typeof u === "function") u(); } catch (e) { /* already gone */ } });
  unsubs = [];
  if (current && current.handle) current.handle.cancel();
  queue.forEach(function (j) { j.resolve({ status: "cancelled", detail: "Plugin stopped" }); });
  queue = [];
  api = null;
}
