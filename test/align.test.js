// Tests use invented lyrics and hand-written, whisper-shaped transcripts: real
// lyrics are copyrighted and this repo is public. The shapes (repeated chorus,
// instrumental break, invented outro repeats, stranded DTW tokens, misheard
// words) come from a real run of whisper-cli on a Greek song.
const { test } = require("node:test");
const assert = require("node:assert");
const { alignLyrics, fold, formatLrcTime, lyricLines } = require("../align.js");

// segments: [[startSecs, "text", { p?, dtw? }]] — each word becomes two tokens
// (" wo" + "rd") 0.3s apart, like whisper's sub-word pieces.
function transcript(segments, { dtw = true } = {}) {
  return {
    transcription: segments.map(([start, text, o = {}]) => {
      const tokens = [{ text: "[_BEG_]", offsets: { from: start * 1000 }, t_dtw: -1, p: 1 }];
      let t = start;
      for (const word of text.split(/\s+/).filter(Boolean)) {
        const cut = Math.max(1, Math.ceil(word.length / 2));
        const pieces = [" " + word.slice(0, cut), word.slice(cut)].filter((x) => x.trim());
        pieces.forEach((piece, i) => {
          const at = t + i * 0.1;
          tokens.push({ text: piece, offsets: { from: Math.round(at * 1000) }, t_dtw: dtw ? Math.round(at * 100) : -1, p: o.p ?? 0.98 });
        });
        t += 0.3;
      }
      return { offsets: { from: start * 1000 }, text, tokens };
    }),
  };
}

const VERSE = "Paper boats along the river\nCarry every word I never said";
const CHORUS = "Hold the lantern, hold it high\nLight the harbour, light the sky";

test("an exact transcript puts every line at its first word, minus the lead", () => {
  const r = alignLyrics(`${VERSE}\n\n${CHORUS}`, transcript([
    [10, "Paper boats along the river"],
    [13, "Carry every word I never said"],
    [20, "Hold the lantern, hold it high"],
    [23, "Light the harbour, light the sky"],
  ]));
  assert.deepEqual(r.lines.map((l) => l.start), [9.75, 12.75, 19.75, 22.75]);
  assert.equal(r.anchoredRatio, 1);
  assert.equal(r.lrc.split("\n")[0], "[00:09.75]Paper boats along the river");
});

test("misheard words still anchor a line", () => {
  const r = alignLyrics(VERSE, transcript([
    [10, "Paper bolts along a liver"],
    [13, "Carey every ward I never sad"],
  ]));
  assert.deepEqual(r.lines.map((l) => l.start), [9.75, 12.75]);
  assert.equal(r.anchoredRatio, 1);
});

test("a word whose first piece DTW stranded before an instrumental break takes the rest's time", () => {
  const t = transcript([[10, "Paper boats along the river"], [40, "Carry every word I never said"]]);
  // The break's first sound lands 9s early, as DTW does after an instrumental.
  t.transcription[1].tokens[1].t_dtw = 3100;
  const r = alignLyrics(VERSE, t);
  assert.equal(r.lines[1].start, 39.75 + 0.1);
});

test("invented repeats over an instrumental outro don't pull the lyrics forward", () => {
  const r = alignLyrics(`${VERSE}\n${CHORUS}`, transcript([
    [10, "Paper boats along the river"],
    [13, "Carry every word I never said"],
    [20, "Hold the lantern, hold it high"],
    [23, "Light the harbour, light the sky"],
    [60, "Hold the lantern, hold it high", { p: 0.6 }],
    [63, "Light the harbour, light the sky", { p: 0.6 }],
    [66, "Hold the lantern, hold it high", { p: 0.5 }],
  ]));
  assert.deepEqual(r.lines.map((l) => l.start), [9.75, 12.75, 19.75, 22.75]);
});

test("transcript before the singing (credits, hallucinated text) is skipped", () => {
  const r = alignLyrics(VERSE, transcript([
    [0, "Subtitles by someone somewhere", { p: 0.4 }],
    [10, "Paper boats along the river"],
    [13, "Carry every word I never said"],
  ]));
  assert.deepEqual(r.lines.map((l) => l.start), [9.75, 12.75]);
});

test("a chorus the lyrics write once but the singer repeats keeps the first copy", () => {
  const r = alignLyrics(`${VERSE}\n${CHORUS}\nPaper boats are gone tonight`, transcript([
    [10, "Paper boats along the river"],
    [13, "Carry every word I never said"],
    [20, "Hold the lantern, hold it high"],
    [23, "Light the harbour, light the sky"],
    [26, "Hold the lantern, hold it high"],
    [29, "Light the harbour, light the sky"],
    [32, "Paper boats are gone tonight"],
  ]));
  assert.deepEqual(r.lines.map((l) => l.start), [9.75, 12.75, 19.75, 22.75, 31.75]);
});

test("without DTW timestamps the token offsets are used", () => {
  const r = alignLyrics(VERSE, transcript([[10, "Paper boats along the river"], [13, "Carry every word I never said"]], { dtw: false }));
  assert.deepEqual(r.lines.map((l) => l.start), [9.75, 12.75]);
});

test("a line whisper didn't hear is placed between its neighbours and counted as unanchored", () => {
  const r = alignLyrics(`${VERSE}\nSilent middle line here\n${CHORUS}`, transcript([
    [10, "Paper boats along the river"],
    [13, "Carry every word I never said"],
    [20, "Hold the lantern, hold it high"],
    [23, "Light the harbour, light the sky"],
  ]));
  assert.equal(r.lines[2].anchored, false);
  assert.ok(r.lines[2].start > r.lines[1].start && r.lines[2].start < r.lines[3].start);
  assert.equal(r.anchoredRatio, 4 / 5);
});

test("Greek folds accents, case and final sigma for matching, and keeps the text as written", () => {
  const lyrics = "Άκου το κύμα στο λιμάνι\nΚαι τα φώτα της αυλής";
  const r = alignLyrics(lyrics, transcript([[5, "ακου το κυμα στο λιμανι"], [8, "ΚΑΙ ΤΑ ΦΩΤΑ ΤΗΣ ΑΥΛΗΣ"]]));
  assert.deepEqual(r.lines.map((l) => [l.text, l.start]), [["Άκου το κύμα στο λιμάνι", 4.75], ["Και τα φώτα της αυλής", 7.75]]);
  assert.equal(fold("Αυλής"), fold("ΑΥΛΗΣ"));
});

test("blank lines and section labels are left out of the result", () => {
  assert.deepEqual(lyricLines("[Chorus]\nHold the lantern\n\n(x2)\n  Light the sky  \r\n"), ["Hold the lantern", "Light the sky"]);
});

test("starts stay strictly increasing and never go below zero", () => {
  const r = alignLyrics("First words here\nSecond words here", transcript([[0.1, "First words here"], [0.2, "Second words here"]]));
  assert.equal(r.lines[0].start, 0);
  assert.ok(r.lines[1].start > r.lines[0].start);
});

test("an empty transcript anchors nothing", () => {
  const r = alignLyrics(VERSE, { transcription: [] });
  assert.equal(r.anchoredRatio, 0);
  assert.equal(r.lrc, "");
});

test("LRC times are mm:ss.cc", () => {
  assert.equal(formatLrcTime(0), "[00:00.00]");
  assert.equal(formatLrcTime(83.456), "[01:23.46]");
  assert.equal(formatLrcTime(600), "[10:00.00]");
});

// ------------------------------------------------------------ transcriptLrc
const { transcriptLrc } = require("../align.js");

// segments: [[fromSecs, toSecs, "text"]], the way `-ojf -ml N -sow` writes them.
function segments(list) {
  return { transcription: list.map(([from, to, text]) => ({ offsets: { from: from * 1000, to: to * 1000 }, text: " " + text })) };
}

test("transcript segments become timed lines, one per segment", () => {
  const r = transcriptLrc(segments([[1.2, 3.9, "Welcome back to the show."], [4.0, 6.5, "Today we talk about boats."]]));
  assert.equal(r.lines, 2);
  assert.equal(r.lrc, "[00:01.20]Welcome back to the show.\n[00:04.00]Today we talk about boats.\n[00:06.50]");
});

test("a long pause clears the line; a short one doesn't", () => {
  const r = transcriptLrc(segments([[0, 2, "One."], [2.5, 4, "Two."], [10, 12, "Three."]]));
  assert.equal(r.lrc, "[00:00.00]One.\n[00:02.50]Two.\n[00:04.00]\n[00:10.00]Three.\n[00:12.00]");
});

test("non-speech segments are left out, so no line reads as an LRC tag", () => {
  const r = transcriptLrc(segments([[0, 5, "[Music]"], [5, 7, "(laughs)"], [7, 9, "♪ ♪"], [9, 11, "Hello there."], [11, 12, "[BLANK_AUDIO]"]]));
  assert.equal(r.lines, 1);
  assert.equal(r.lrc, "[00:09.00]Hello there.\n[00:11.00]");
});

test("whisper's loops are cut after two repeats", () => {
  const r = transcriptLrc(segments([[0, 1, "Thank you."], [1, 2, "Thank you."], [2, 3, "thank you"], [3, 4, "Thank you."], [4, 5, "Goodbye."]]));
  assert.equal(r.lines, 3);
  assert.match(r.lrc, /Goodbye\.$/m);
});

test("with the media's length, a closing empty line lands at its end", () => {
  const r = transcriptLrc(segments([[1, 3, "Only at the start."]]), { durationSecs: 1030.87 });
  assert.equal(r.lrc, "[00:01.00]Only at the start.\n[00:03.00]\n[17:10.87]");
});

test("nothing past 99:59.99 is written, since LRC minutes have two digits", () => {
  const r = transcriptLrc(segments([[5990, 5995, "Near the end."], [6001, 6003, "Too late."]]), { durationSecs: 7200 });
  assert.equal(r.lines, 1);
  assert.equal(r.lrc, "[99:50.00]Near the end.\n[99:55.00]");
});

test("an empty or speechless transcript has no lines", () => {
  assert.deepEqual(transcriptLrc({ transcription: [] }), { lrc: "", lines: 0, lastSecs: 0 });
  assert.equal(transcriptLrc(segments([[0, 30, "[Music]"]]), { durationSecs: 60 }).lrc, "");
});
