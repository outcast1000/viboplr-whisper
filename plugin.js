// Whisper: synced lyrics for a track, by listening to it.
//
// scripts/build.mjs joins align.js (as `WhisperAlign`) and this file into
// index.js, the one file the plugin loader reads. Edit these two, never
// index.js.
//
// One job per track, three kinds of work:
//   sync        time the song's plain lyrics: ffmpeg → 16 kHz mono WAV →
//               whisper-cli (DTW token times, the lyrics as prompt) → align.
//   resync      the same for synced lyrics that are off: their timestamps are
//               dropped and the words timed again.
//   transcribe  write down what Whisper hears (subtitle-sized segments) as
//               timed lines. For a video, synced lyrics are its subtitles.
//
// Two menu items:
//   "Sync lyrics with Whisper"   (mode "whisper") keeps the words the track
//                                has: plain → sync, synced → resync. A track
//                                with none is transcribed.
//   "Transcribe with Whisper"    (mode "transcribe") uses the words Whisper
//                                hears, whatever the track has now.
//
// What a job the user started produces is a DRAFT, never a save: it is shown
// in the app's lyrics editor (`requestAction("review-lyrics")`) and the
// user's Save there is the approval. The app says how each review ended
// (`api.ui.onAction("review-lyrics:closed")`: saved or discarded), and the
// draft is dropped then. Only automatic
// mode and the assistant's `sync_lyrics` save directly, and only plain lyrics
// that matched well (MIN_ANCHORED), since nobody is there to review.
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
// is saved without review. Below it a direct save saves nothing (wrong
// timings kept forever are worse than none), and a draft says to check it.
var MIN_ANCHORED = 0.7;
var MIN_TRACK_SECS = 60;
var AUTO_DELAY_MS = 5000;
var MAX_QUEUE = 20;
var MAX_RECENT = 25;
var MAX_DRAFTS = 30;
var PROMPT_CHARS = 220;
// Longest transcribed line, in characters: two lines of a subtitle.
var SUBTITLE_CHARS = 84;
// Unplaced lines named in a draft's note.
var NOTE_LINES = 3;

var api = null;
var settings = DEFAULT_SETTINGS;
var recent = [];        // [{ id, title, artist, album, mode, status, detail, at }]
var drafts = [];        // [{ id, title, artist, album, video, work, text, note, detail, at }], newest first
var songStatus = {};    // songKey → last sync outcome, for automatic mode ("tried before")
var queue = [];         // [{ id, song, mode, deliver, onlyIfNone, manual, batch, resolve }]
var current = null;     // the running job + { step, percent, handle, startedAt, listenStartedAt, cancelled }
var working = false;
var jobSeq = 0;
var ticker = null;      // redraws the elapsed time while a job runs
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

var SHOW_PROGRESS = { label: "Show progress", id: "show-progress" };
var REVIEW_NEXT = { label: "Review", id: "review-next" };

var WORK_VERB = { sync: "Syncing the lyrics of ", resync: "Re-timing the lyrics of ", transcribe: "Transcribing " };

// A job the user asked for takes tens of seconds, and its progress is drawn
// only in this plugin's settings panel: say it started, with a way there.
// Once per request — five tracks are one notice, not five.
function announceStart(job, work) {
  var b = job.batch;
  if (!b || b.announced) return;
  b.announced = true;
  var msg = b.total > 1
    ? "Whisper is working on " + b.total + " tracks…"
    : (WORK_VERB[work] || "Working on ") + describe(job.song) + "…";
  notify(msg, "info", SHOW_PROGRESS);
}

function save() {
  return Promise.all([
    api.storage.set("settings", settings),
    api.storage.set("recent", recent),
    api.storage.set("drafts", drafts),
    api.storage.set("songStatus", songStatus),
  ]).catch(function (e) { log("error", "Saving state failed: " + e); });
}

// songStatus is what automatic syncing reads ("tried before"), so only timing
// outcomes go there, and not a cancel: a transcription must not stop a song's
// plain lyrics being timed later.
function record(song, mode, status, detail) {
  // The id is unique even for entries recorded in the same millisecond
  // (Cancel all records every waiting job at once).
  var at = Date.now();
  recent.unshift({ id: "r" + at + "-" + (++jobSeq), title: song.title, artist: song.artistName, album: song.albumTitle || null, mode: mode, status: status, detail: detail || "", at: at });
  if (recent.length > MAX_RECENT) recent.length = MAX_RECENT;
  if ((mode === "sync" || mode === "resync") && status !== "cancelled") songStatus[songKey(song.title, song.artistName)] = status;
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

// → { state: "none" | "synced" | "plain" | "file" | "unknown", text? }
// "unknown": the lyrics providers failed. Not the same as no lyrics — a
// transcript then would stand in for lyrics the song does have.
// "file": plain lyrics read from the song's own file. A review saves them
// back there (the editor's own save); a direct save would go to the app's
// cache and be undone by the next re-read of the file, so it skips them.
function readLyrics(song) {
  return api.informationTypes.fetch("lyrics", lyricsEntity(song)).then(function (r) {
    if (r && r.status === "error") return { state: "unknown" };
    var v = r && r.status === "ok" ? r.value : null;
    var text = v && typeof v.text === "string" ? v.text.trim() : "";
    if (!text) return { state: "none" };
    if (v.kind === "synced") return { state: "synced", text: text };
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
    onStart: function (handle) {
      if (!current) return;
      current.handle = handle;
      if (current.cancelled) handle.cancel();
    },
    onOutput: onLine,
  }).then(function (r) {
    if (r.exitCode !== 0) throw new Error(program + " failed: " + (lastLines(r.stderr, 3) || "exit " + r.exitCode));
    return r;
  });
}

// Cancel can be pressed between programs too (reading the lyrics, saving),
// where there is no process to kill: each step checks before it starts.
function setStep(step, percent) {
  if (!current) return;
  if (current.cancelled) throw new Error("Cancelled");
  current.step = step;
  current.percent = percent == null ? null : percent;
  render();
}

function done(status, detail, extra) {
  var r = { status: status, detail: detail };
  if (extra) for (var k in extra) r[k] = extra[k];
  return r;
}

// What the track's lyrics mean for this job: { work, words? } to go on, or
// { stop } with the reason not to. `words` is the plain text to time.
function plan(l, job) {
  var direct = job.deliver === "save";
  if (job.mode === "transcribe") {
    if (job.onlyIfNone && l.state === "unknown") return { stop: done("failed", "Couldn't read the track's lyrics; try again later") };
    if (job.onlyIfNone && l.state === "synced") return { stop: done("skipped", "Already has synced lyrics") };
    if (job.onlyIfNone && l.state !== "none") return { stop: done("skipped", "Already has lyrics; \"Sync lyrics with Whisper\" times them") };
    return { work: "transcribe" };
  }
  if (l.state === "unknown") return { stop: done("failed", "Couldn't read the track's lyrics; try again later") };
  if (l.state === "none") {
    if (job.mode === "whisper") return { work: "transcribe" };
    return { stop: done("skipped", "No lyrics to time") };
  }
  if (l.state === "synced") {
    if (direct) return { stop: done("skipped", "Already synced") };
    var words = Align.lrcToPlain(l.text);
    if (!words) return { stop: done("skipped", "The synced lyrics have no words to time") };
    return { work: "resync", words: words };
  }
  // A direct save has nobody to check it, so it keeps to songs: a video's
  // intro and a clip's few lines are where timings go wrong unseen.
  if (direct && job.song.video) return { stop: done("skipped", "A video; sync it from the menu to review the timings") };
  if (direct && job.song.durationSecs && job.song.durationSecs < MIN_TRACK_SECS) return { stop: done("skipped", "Shorter than a minute") };
  if (l.state === "file" && direct) {
    return { stop: done("skipped", "Lyrics come from the song's file; sync it from the menu to review and save them there") };
  }
  return { work: "sync", words: l.text };
}

function whisperArgs(work, paths, words) {
  var args = ["-m", paths.model, "-f", paths.wav, "-l", settings.language || "auto", "-ojf", "-of", paths.out, "-pp"];
  if (work === "transcribe") return args.concat(["-ml", String(SUBTITLE_CHARS), "-sow"]);
  var prompt = words.replace(/\s+/g, " ").slice(0, PROMPT_CHARS);
  return args.concat(["-nfa", "-dtw", model().dtw, "--prompt", prompt]);
}

function quoteLines(lines) {
  var shown = lines.slice(0, NOTE_LINES).map(function (t) { return "“" + t + "”"; }).join(", ");
  return lines.length > NOTE_LINES ? shown + " and " + (lines.length - NOTE_LINES) + " more" : shown;
}

// What the review banner says to check, for timed lyrics.
function alignNote(r, work) {
  var pct = Math.round(r.anchoredRatio * 100);
  var lead = work === "resync" ? "The song's lyrics, timed again. " : "";
  var guessed = r.lines.filter(function (l) { return !l.anchored; }).map(function (l) { return l.text; });
  if (r.anchoredRatio < MIN_ANCHORED) {
    return lead + "Only " + pct + "% of lines matched what was sung, so these may be other lyrics or another version. Check the times carefully, or use \"Transcribe with Whisper\" instead.";
  }
  if (!guessed.length) return lead + "Every line matched what was sung.";
  return lead + pct + "% of lines matched what was sung. " +
    (guessed.length === 1 ? "One line was" : guessed.length + " lines were") +
    " placed between their neighbours, so check " + (guessed.length === 1 ? "it" : "them") + ": " + quoteLines(guessed) + ".";
}

// Transcript → { lrc?, result }: the synced text, and what to report.
function finish(job, work, transcript, words) {
  var song = job.song;
  if (work === "transcribe") {
    var t = Align.transcriptLrc(transcript, { durationSecs: song.durationSecs || undefined });
    if (!t.lines) return { result: done("skipped", "Whisper heard no speech") };
    var note = "What Whisper heard: check the words, names and repeated lines especially." +
      (song.video ? " Saved, they're the video's subtitles." : "");
    return { lrc: t.lrc, note: note, result: done(job.deliver === "save" ? "saved" : "draft", t.lines + " lines", { lines: t.lines }) };
  }
  var r = Align.alignLyrics(words, transcript, { durationSecs: song.durationSecs || undefined });
  var pct = Math.round(r.anchoredRatio * 100);
  var extra = { ratio: r.anchoredRatio };
  if (!r.lrc) return { result: done("low-confidence", "Whisper heard nothing to line the lyrics up with", extra) };
  if (job.deliver === "save") {
    if (r.anchoredRatio < MIN_ANCHORED) {
      return { result: done("low-confidence", "Only " + pct + "% of lines matched what was sung", extra) };
    }
    return { lrc: r.lrc, result: done("saved", pct + "% of lines matched", extra) };
  }
  return { lrc: r.lrc, note: alignNote(r, work), result: done("draft", pct + "% of lines matched", extra) };
}

// A finished draft, kept until the user saves or discards it. One per song.
function keepDraft(job, work, lrc, note, detail) {
  var s = job.song;
  var key = songKey(s.title, s.artistName);
  drafts = drafts.filter(function (d) { return songKey(d.title, d.artist) !== key; });
  var d = { id: "d" + Date.now() + "-" + (++jobSeq), title: s.title, artist: s.artistName, album: s.albumTitle || null, video: !!s.video, work: work, text: lrc, note: note, detail: detail, at: Date.now() };
  drafts.unshift(d);
  if (drafts.length > MAX_DRAFTS) drafts.length = MAX_DRAFTS;
  save();
  return d;
}

// → Promise<{ status, detail, mode, draft?, ratio?, lines? }>; never rejects.
// `mode` in the result is the work that ran ("sync" / "resync" /
// "transcribe"), or the requested mode when it stopped before deciding.
function runJob(job) {
  var song = job.song;
  var work = job.mode;
  var id = "job-" + Date.now();
  var wav = id + ".wav", out = id;
  var paths = {};
  var lyrics, words;

  var steps = !song.path ? Promise.resolve(done("skipped", "Not a local file")) : Promise.resolve().then(function () {
    setStep("Checking lyrics");
    return readLyrics(song);
  }).then(function (l) {
    lyrics = l;
    var p = plan(l, job);
    if (p.stop) return p.stop;
    work = p.work;
    words = p.words;
    if (current) current.work = work;
    return refreshWhisperStatus().then(function (s) {
      if (!s || !s.installed) return done("failed", "whisper-cli isn't installed", { needs: "whisper-cli" });
      return modelPath().then(function (mp) {
        if (!mp) return done("failed", "The Whisper model isn't downloaded", { needs: "model" });
        paths.model = mp;
        return Promise.all([tmpPath(wav), tmpPath(out)]).then(function (p2) {
          paths.wav = p2[0];
          paths.out = p2[1];
          if (job.manual) announceStart(job, work);
          setStep("Reading the audio");
          return exec("ffmpeg", ["-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i", song.path, "-vn", "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", paths.wav]);
        }).then(function () {
          setStep("Listening", 0);
          if (current) current.listenStartedAt = Date.now();
          return exec("whisper-cli", whisperArgs(work, paths, words), function (line) {
            var m = /progress\s*=\s*(\d+)%/.exec(line);
            if (m && current && !current.cancelled) { current.percent = +m[1]; render(); }
          });
        }).then(function () {
          setStep(work === "transcribe" ? "Writing the lines" : "Lining up the lyrics");
          return api.storage.files.readJson(["tmp", out + ".json"]);
        }).then(function (transcript) {
          // Cancel pressed while the transcript was read: no draft, no save.
          if (current && current.cancelled) throw new Error("Cancelled");
          var f = finish(job, work, transcript, words);
          if (!f.lrc) return f.result;
          if (job.deliver !== "save") {
            f.result.draft = keepDraft(job, work, f.lrc, f.note, f.result.detail);
            return f.result;
          }
          // Read again: the user may have saved lyrics while this ran.
          return readLyrics(song).then(function (again) {
            if (again.state !== lyrics.state) {
              return done("skipped", "The lyrics changed while " + (work === "transcribe" ? "transcribing" : "timing them"));
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
  });

  return steps.catch(function (e) {
    var msg = e && e.message ? e.message : String(e);
    if (msg === "Cancelled") return done("cancelled", "Cancelled");
    log("error", (WORK_VERB[work] || "Working on ") + describe(song) + " failed: " + msg);
    return done("failed", msg);
  }).then(function (r) {
    r.mode = work;
    return removeTmp([wav, out + ".json"]).then(function () { return r; });
  });
}

// ---------------------------------------------------------------- the queue

// A batch is one request from the user (a menu click on one or many tracks):
// it gets one start notice and, for several tracks, one summary at the end.
function newBatch(total) {
  return { total: total, results: [], announced: false };
}

// opts: { mode: "whisper" | "sync" | "transcribe", deliver: "draft" | "save",
//         onlyIfNone?, manual?, batch? }
function enqueue(song, opts) {
  var batch = opts.batch || null;
  var key = songKey(song.title, song.artistName);
  var dup = (current && songKey(current.song.title, current.song.artistName) === key) ||
    queue.some(function (j) { return songKey(j.song.title, j.song.artistName) === key; });
  var refused = dup ? "Already being worked on" : queue.length >= MAX_QUEUE ? "Too many tracks waiting" : null;
  if (refused) {
    var r = { status: "skipped", detail: refused, mode: opts.mode };
    if (batch) settle({ song: song, manual: !!opts.manual, batch: batch }, r);
    return Promise.resolve(r);
  }
  return new Promise(function (resolve) {
    var job = { id: "j" + (++jobSeq), song: song, mode: opts.mode, deliver: opts.deliver, onlyIfNone: !!opts.onlyIfNone, manual: !!opts.manual, batch: batch, resolve: resolve };
    // A new request goes ahead of older waiting ones (it's what the user just
    // asked for, or just started playing); a request's own tracks keep their
    // order behind its first.
    var at = 0;
    if (batch) queue.forEach(function (j, i) { if (j.batch === batch) at = i + 1; });
    queue.splice(at, 0, job);
    render();
    pump();
  });
}

function startTicker() {
  if (!ticker) ticker = setInterval(function () { if (current) render(); }, 1000);
}

function stopTicker() {
  if (ticker) { clearInterval(ticker); ticker = null; }
}

function pump() {
  if (working || !queue.length) return;
  working = true;
  var job = queue.shift();
  current = { id: job.id, song: job.song, work: null, step: "Starting", percent: null, handle: null, startedAt: Date.now(), listenStartedAt: null, cancelled: false };
  startTicker();
  render();
  runJob(job).then(function (result) {
    if (!api) { job.resolve(result); return; } // deactivated mid-job
    if (result.status !== "draft") record(job.song, result.mode, result.status, result.detail);
    settle(job, result);
    job.resolve(result);
  }).then(function () {
    current = null;
    working = false;
    if (!api) return;
    if (!queue.length) stopTicker();
    render();
    pump();
  });
}

// A job's outcome told to the user: on its own for a single track, folded
// into one summary for a request of several.
function settle(job, result) {
  var b = job.batch;
  if (!b || b.total <= 1) { announce(job, result); return; }
  b.results.push(result);
  if (b.results.length === b.total) summarize(b);
}

function summarize(b) {
  var n = { draft: 0, low: 0, failed: 0, skipped: 0, cancelled: 0 };
  b.results.forEach(function (r) {
    if (r.status === "low-confidence") n.low++;
    else if (n[r.status] != null) n[r.status]++;
  });
  if (n.cancelled === b.total) return; // the user stopped all of it
  var parts = [];
  if (n.draft) parts.push(n.draft + " ready to review");
  if (n.low) parts.push(n.low + " couldn't be timed");
  if (n.failed) parts.push(n.failed + " failed");
  if (n.skipped) parts.push(n.skipped + " skipped");
  if (n.cancelled) parts.push(n.cancelled + " cancelled");
  var kind = n.failed && !n.draft ? "error" : n.failed || n.low ? "warning" : n.draft ? "success" : "info";
  notify("Finished " + b.total + " tracks: " + parts.join(", ") + ".", kind, n.draft ? REVIEW_NEXT : { label: "Details", id: "show-progress" });
}

function announce(job, result) {
  var name = describe(job.song);
  var work = result.mode;
  if (result.status === "cancelled") return;
  if (result.status === "draft") {
    var low = typeof result.ratio === "number" && result.ratio < MIN_ANCHORED;
    var msg = work === "transcribe" ? "The transcript of " + name + " is ready to review"
      : work === "resync" ? "New timings for " + name + " are ready to review"
        : "Timed lyrics for " + name + " are ready to review";
    notify(low ? msg + ". Few lines matched, so check them carefully." : msg + ".", low ? "warning" : "success", REVIEW_NEXT);
    return;
  }
  if (result.status === "saved") {
    notify(work === "transcribe" ? "Transcribed " + name : "Synced lyrics for " + name, "success");
    return;
  }
  if (!job.manual) return;
  var what = work === "transcribe" ? "transcribe " : "time the lyrics of ";
  if (result.status === "low-confidence") notify("Couldn't " + what + name + ": " + result.detail + ".", "warning");
  else if (result.status === "failed") notify("Couldn't " + what + name + ": " + result.detail, "error");
  else if (result.status === "skipped") notify("Didn't " + what + name + ": " + result.detail, "info");
}

// One job by id, or (null) the running one and everything waiting.
function cancelJob(id) {
  if (current && !current.cancelled && (id == null || current.id === id)) {
    current.cancelled = true;
    current.step = "Cancelling";
    current.percent = null;
    if (current.handle) current.handle.cancel();
  }
  var keep = [];
  queue.forEach(function (j) {
    if (id != null && j.id !== id) { keep.push(j); return; }
    var r = { status: "cancelled", detail: "Cancelled", mode: j.mode };
    record(j.song, j.mode, r.status, r.detail);
    settle(j, r);
    j.resolve(r);
  });
  queue = keep;
  render();
}

// ------------------------------------------------------------------ drafts

function draftById(id) {
  for (var i = 0; i < drafts.length; i++) if (drafts[i].id === id) return drafts[i];
  return null;
}

// Opens the song's track page with the draft in the lyrics editor. Nothing is
// saved here: the user's Save there is the approval.
function reviewDraft(d) {
  if (!d) return;
  api.ui.requestAction("review-lyrics", {
    title: d.title,
    artistName: d.artist || undefined,
    albumTitle: d.album || undefined,
    text: d.text,
    note: d.note || undefined,
    source: "Whisper",
  });
}

function discardDraft(d) {
  if (!d) return;
  drafts = drafts.filter(function (x) { return x.id !== d.id; });
  record({ title: d.title, artistName: d.artist, albumTitle: d.album }, d.work, "discarded", "Draft discarded");
  render();
}

// The app says how a review ended (`review-lyrics:closed`): saved, or
// discarded. Only that ends a draft — an unrelated edit of the song's lyrics
// doesn't, and a discard in the editor no longer leaves the draft behind
// (where it would also keep automatic syncing off for the song).
function onReviewClosed(p) {
  if (!p || typeof p.title !== "string") return;
  var key = songKey(p.title, p.artistName);
  var d = null;
  for (var i = 0; i < drafts.length; i++) if (songKey(drafts[i].title, drafts[i].artist) === key) { d = drafts[i]; break; }
  if (!d) return;
  drafts = drafts.filter(function (x) { return x.id !== d.id; });
  var song = { title: d.title, artistName: d.artist, albumTitle: d.album };
  if (p.outcome === "saved") record(song, d.work, "saved", "Saved after review");
  else record(song, d.work, "discarded", "Draft discarded");
  render();
  if (drafts.length) {
    notify((p.outcome === "saved" ? "Saved. " : "") + drafts.length + (drafts.length === 1 ? " more draft" : " more drafts") + " to review.", p.outcome === "saved" ? "success" : "info", { label: "Review next", id: "review-next" });
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

// What's missing before Whisper can run: "whisper-cli" | "model" | null.
function missingSetup() {
  return Promise.all([refreshWhisperStatus(), modelPath()]).then(function (r) {
    render.modelReady = !!r[1];
    if (!r[0] || !r[0].installed) return "whisper-cli";
    if (!r[1]) return "model";
    return null;
  });
}

// The menu items (and Try again): check the setup once for the whole
// request, then queue it as one batch of drafts.
function runFromMenu(targets, mode) {
  return missingSetup().then(function (missing) {
    if (missing) {
      render();
      notify(missing === "whisper-cli"
        ? "Whisper needs whisper-cli first. Install it from the plugin's settings."
        : "Whisper needs its model first. Download it from the plugin's settings.", "warning",
      { label: "Set up", id: "show-progress" });
      return;
    }
    return Promise.all(targets.map(songFromTarget)).then(function (songs) {
      songs = songs.filter(Boolean);
      if (!songs.length) {
        notify("Whisper works on tracks in your library" + (targets.length > 1 ? "; none of these are." : ", and this one isn't."), "info");
        return;
      }
      var batch = newBatch(songs.length);
      songs.forEach(function (song) { enqueue(song, { mode: mode, deliver: "draft", manual: true, batch: batch }); });
    });
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
  var key = songKey(song.title, song.artistName);
  if (songStatus[key]) return; // tried before; the menu item retries
  if (drafts.some(function (d) { return songKey(d.title, d.artist) === key; })) return; // waiting for review
  var trackKey = track.key;
  var t = setTimeout(function () {
    var now = api.playback.getCurrentTrack();
    if (!now || now.key !== trackKey) return; // skipped already
    enqueue(song, { mode: "sync", deliver: "save" });
  }, AUTO_DELAY_MS);
  timers.push(t);
}

// ------------------------------------------------------------------ panel

function clock(ms) {
  var s = Math.max(0, Math.round(ms / 1000));
  var m = Math.floor(s / 60);
  s %= 60;
  return m + ":" + (s < 10 ? "0" : "") + s;
}

function ago(at) {
  var mins = Math.round((Date.now() - at) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return mins + " min ago";
  var h = Math.round(mins / 60);
  if (h < 24) return h + " h ago";
  return Math.round(h / 24) + " d ago";
}

// A double-click runs a row's `action`, else its first hover action: give
// every row one, or a double-click on the running job would cancel it.
function songRow(id, song, action) {
  var row = { id: id, title: song.title, action: action || "open-track" };
  if (song.artistName) row.artistName = song.artistName;
  if (song.albumTitle) row.albumTitle = song.albumTitle;
  return row;
}

var WORK_BADGE = { sync: "Syncing", resync: "Re-timing", transcribe: "Transcribing" };

// The running job: what it's doing, how far, how long so far and — once
// Whisper is reporting — about how long is left.
function currentRow() {
  var c = current;
  var now = Date.now();
  var bits = [c.step];
  if (c.percent != null && !c.cancelled) bits.push(c.percent + "%");
  bits.push(clock(now - c.startedAt));
  if (!c.cancelled && c.percent != null && c.percent >= 5 && c.percent < 100 && c.listenStartedAt) {
    var spent = now - c.listenStartedAt;
    if (spent > 3000) bits.push("about " + clock(spent * (100 - c.percent) / c.percent) + " left");
  }
  var row = songRow(c.id, c.song);
  row.subtitle = (c.song.artistName ? c.song.artistName + " · " : "") + bits.join(" · ");
  row.badge = c.cancelled
    ? { label: "Cancelling", variant: "muted" }
    : { label: WORK_BADGE[c.work] || "Starting", variant: "accent", pulse: true };
  row.progress = !c.cancelled && c.percent != null ? c.percent / 100 : "indeterminate";
  row.actions = c.cancelled ? [] : ["cancel-job"];
  return row;
}

function waitingRow(j) {
  var row = songRow(j.id, j.song);
  row.subtitle = j.song.artistName || "";
  row.badge = { label: "Waiting", variant: "muted" };
  row.actions = ["cancel-job"];
  return row;
}

var DRAFT_KIND = { sync: "Timed lyrics", resync: "New timings", transcribe: "Transcript" };

function draftRow(d) {
  var row = songRow(d.id, { title: d.title, artistName: d.artist, albumTitle: d.album }, "review-draft");
  row.subtitle = [d.artist, DRAFT_KIND[d.work] + (d.detail ? " · " + d.detail : ""), ago(d.at)].filter(Boolean).join(" · ");
  row.badge = { label: "To review", variant: "accent" };
  row.actions = ["review-draft", "discard-draft"];
  return row;
}

var BADGE_VARIANTS = { saved: "success", "low-confidence": "warning", failed: "error", skipped: "muted", cancelled: "muted", discarded: "muted" };

function statusLabel(r) {
  if (r.status === "saved") return r.mode === "transcribe" ? "Transcribed" : "Synced";
  return { "low-confidence": "Not timed", failed: "Failed", skipped: "Skipped", cancelled: "Cancelled", discarded: "Discarded" }[r.status] || r.status;
}

function recentRow(r, i) {
  var row = songRow(r.id || "r" + r.at + "-" + i, { title: r.title, artistName: r.artist, albumTitle: r.album });
  row.subtitle = [r.artist, r.detail, ago(r.at)].filter(Boolean).join(" · ");
  row.badge = { label: statusLabel(r), variant: BADGE_VARIANTS[r.status] || "default" };
  row.actions = r.status === "failed" || r.status === "cancelled" ? ["retry"] : [];
  return row;
}

// Rows the host draws like a track list (artwork, a status chip, a bar),
// one row current, its actions on hover. The rows are jobs, not things to
// play, so no track menu; art only when it's already on disk.
function rowList(items, actions) {
  return { type: "track-row-list", selectable: true, selectionMode: "single", contextMenu: false, artwork: "cached", items: items, actions: actions };
}

function render() {
  if (!api) return;
  var m = model();
  var children = [];

  children.push({ type: "text", content: "Gives tracks synced lyrics by listening to them with Whisper. Right-click tracks and choose \"Sync lyrics with Whisper\" to time the words a track has (plain lyrics, or synced ones that are off; a track with none is transcribed), or \"Transcribe with Whisper\" to use the words Whisper hears instead. Each result opens in the lyrics editor for you to check; nothing replaces a track's lyrics until you Save there. Local files only." });

  // Work first, so "Show progress" lands on it.
  if (current || queue.length) {
    var rows = [];
    if (current) rows.push(currentRow());
    queue.forEach(function (j) { rows.push(waitingRow(j)); });
    var work = [rowList(rows, [{ id: "cancel-job", label: "Cancel" }])];
    if (queue.length) {
      work.push({ type: "toolbar", buttons: [{ label: "Cancel all", action: "cancel-all", variant: "secondary" }], status: queue.length + " waiting" });
    }
    children.push({ type: "section", title: "Working", children: work });
  }

  if (drafts.length) {
    children.push({
      type: "section",
      title: "Ready to review",
      children: [rowList(drafts.map(draftRow), [{ id: "review-draft", label: "Review" }, { id: "discard-draft", label: "Discard" }])],
    });
  }

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
  children.push({ type: "toggle", label: "Sync automatically", description: "When a song with plain lyrics starts playing, time its lyrics in the background and save them without asking, if at least 70% of the lines matched. Each song is tried once. Never transcribes and never touches synced lyrics.", action: "set-auto", checked: !!settings.auto });

  children.push({
    type: "section",
    title: "Recent",
    children: recent.length
      ? [rowList(recent.map(recentRow), [{ id: "retry", label: "Try again" }]),
         { type: "toolbar", buttons: [{ label: "Clear", action: "clear-recent", variant: "secondary" }] }]
      : [{ type: "text", content: "Nothing yet. Right-click a track and choose \"Sync lyrics with Whisper\"." }],
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

function songFromArgs(args) {
  var title = args && typeof args.title === "string" ? args.title.trim() : "";
  var artist = args && typeof args.artistName === "string" ? args.artistName.trim() : "";
  if (!title) return Promise.reject(new Error("title is required"));
  return findLocal(title, artist).then(function (song) {
    if (!song) throw new Error("No library track matches \"" + title + "\"" + (artist ? " by " + artist : ""));
    return song;
  });
}

function rowId(p) {
  if (!p) return null;
  if (typeof p.itemId === "string") return p.itemId;
  return Array.isArray(p.selectedIds) && typeof p.selectedIds[0] === "string" ? p.selectedIds[0] : null;
}

// By the entry's own id. Entries saved before ids existed are found by the
// "r<at>-<index>" their row was given.
function recentById(id) {
  if (typeof id !== "string" || id.charAt(0) !== "r") return null;
  var i;
  for (i = 0; i < recent.length; i++) if (recent[i].id === id) return recent[i];
  var parts = id.slice(1).split("-");
  var r = recent[+parts[1]];
  return r && !r.id && r.at === +parts[0] ? r : null;
}

function activate(pluginApi) {
  api = pluginApi;
  Promise.all([api.storage.get("settings"), api.storage.get("recent"), api.storage.get("songStatus"), api.storage.get("drafts")]).then(function (v) {
    settings = Object.assign({}, DEFAULT_SETTINGS, v[0] || {});
    recent = Array.isArray(v[1]) ? v[1] : [];
    songStatus = v[2] && typeof v[2] === "object" ? v[2] : {};
    drafts = Array.isArray(v[3]) ? v[3].filter(function (d) { return d && d.id && d.text; }) : [];
    return refreshPanel();
  }).catch(function (e) { log("error", "Loading state failed: " + e); });

  unsubs.push(api.contextMenu.onAction("sync-lyrics", function (target) {
    runFromMenu(menuTargets(target), "whisper").catch(function (e) { notify("Couldn't start Whisper: " + e, "error"); });
  }));
  unsubs.push(api.contextMenu.onAction("transcribe", function (target) {
    runFromMenu(menuTargets(target), "transcribe").catch(function (e) { notify("Couldn't start Whisper: " + e, "error"); });
  }));

  unsubs.push(api.ui.onAction("show-progress", function () {
    api.ui.requestAction("open-extension-settings", { section: "configuration" });
  }));

  unsubs.push(api.playback.onTrackStarted(onTrackStarted));

  unsubs.push(api.ui.onAction("review-lyrics:closed", onReviewClosed));

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
  unsubs.push(api.ui.onAction("cancel-job", function (p) {
    var id = rowId(p);
    if (id) cancelJob(id);
  }));
  unsubs.push(api.ui.onAction("cancel-all", function () { cancelJob(null); }));
  unsubs.push(api.ui.onAction("clear-recent", function () { recent = []; save(); render(); }));
  unsubs.push(api.ui.onAction("review-draft", function (p) { reviewDraft(draftById(rowId(p))); }));
  unsubs.push(api.ui.onAction("discard-draft", function (p) { discardDraft(draftById(rowId(p))); }));
  unsubs.push(api.ui.onAction("review-next", function () { reviewDraft(drafts[0]); }));
  unsubs.push(api.ui.onAction("open-track", function (p) {
    var id = rowId(p);
    var song = null;
    if (current && current.id === id) song = current.song;
    queue.forEach(function (j) { if (j.id === id) song = j.song; });
    var r = recentById(id);
    if (r) song = { title: r.title, artistName: r.artist, albumTitle: r.album };
    if (!song) return;
    api.ui.requestAction("navigate-to-track", { name: song.title, artistName: song.artistName || undefined, albumTitle: song.albumTitle || undefined });
  }));
  unsubs.push(api.ui.onAction("retry", function (p) {
    var r = recentById(rowId(p));
    if (!r) return;
    runFromMenu([{ title: r.title, artistName: r.artist }], r.mode === "transcribe" ? "transcribe" : "whisper")
      .catch(function (e) { notify("Couldn't start Whisper: " + e, "error"); });
  }));

  if (api.assistant && typeof api.assistant.onTool === "function") {
    unsubs.push(api.assistant.onTool("sync_lyrics", function (args) {
      return songFromArgs(args).then(function (song) { return enqueue(song, { mode: "sync", deliver: "save" }); });
    }));
    unsubs.push(api.assistant.onTool("transcribe", function (args) {
      return songFromArgs(args).then(function (song) {
        return enqueue(song, { mode: "transcribe", deliver: "draft", onlyIfNone: true });
      }).then(function (r) {
        if (r.status !== "draft") return r;
        return { status: "draft", detail: r.detail, lines: r.lines, note: "Not saved yet: the user reviews it in Whisper's settings (Ready to review) and saves it from the lyrics editor." };
      });
    }));
  }
}

function deactivate() {
  timers.forEach(function (t) { clearTimeout(t); clearInterval(t); });
  timers = [];
  stopTicker();
  unsubs.forEach(function (u) { try { if (typeof u === "function") u(); } catch (e) { /* already gone */ } });
  unsubs = [];
  if (current) { current.cancelled = true; if (current.handle) current.handle.cancel(); }
  queue.forEach(function (j) { j.resolve({ status: "cancelled", detail: "Plugin stopped" }); });
  queue = [];
  api = null;
}
