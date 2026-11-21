// Align a song's plain lyrics to whisper.cpp's transcript of it, giving each
// line a start time. Pure: no plugin API, no I/O. The plugin loads this file
// as part of its code; tests require() it.
//
// Input transcript: the JSON `whisper-cli -ojf` writes (run with `-dtw <model>`
// and `-nfa` so tokens carry `t_dtw`; without DTW the segment offsets are used).
//
// How it works:
//   1. Transcript → words. A token starting with a space starts a word. A
//      word's time is its first token's DTW time (centiseconds), else the
//      token's offset. DTW sometimes strands a word's first piece seconds
//      before the rest after an instrumental break; then the rest's time wins.
//   2. Lyrics → words, folded (case, accents, final sigma, punctuation) for
//      matching only. The lyric text itself is never changed.
//   3. Global alignment (Needleman–Wunsch) of lyric words against transcript
//      words, matching by edit-distance similarity weighted by whisper's
//      confidence. Skipping transcript costs less than skipping lyrics
//      (whisper hears repeats the lyrics write once), and transcript before
//      the first match or after the last is free (intro credits, invented
//      repeats over an instrumental outro).
//   4. A line is anchored when one of its first two words matched; it starts
//      there. Other lines are placed between their anchored neighbours.
//   5. Every line moves `leadSecs` earlier (DTW runs ~0.25s late against
//      sung onsets, and a line shown just before it's sung reads right).
//
// The caller decides whether to keep the result: `anchoredRatio` is the share
// of lines that were anchored, not interpolated.
(function (root) {
  "use strict";

  var DEFAULTS = {
    leadSecs: 0.25,
    minSimilarity: 0.5,
    lyricGap: -1,
    transcriptGap: -0.5,
    strandedSecs: 1,
    // Seconds per line when an unanchored line has a neighbour on one side only.
    fallbackLineSecs: 3,
  };

  function fold(s) {
    return String(s)
      .normalize("NFD")
      .replace(/\p{M}/gu, "")
      .toLowerCase()
      .replace(/ς/g, "σ")
      .replace(/[^\p{L}\p{N}]/gu, "");
  }

  function similarity(a, b) {
    if (a === b) return 1;
    var m = a.length, n = b.length;
    if (!m || !n) return 0;
    var prev = new Array(n + 1), cur = new Array(n + 1);
    for (var j = 0; j <= n; j++) prev[j] = j;
    for (var i = 1; i <= m; i++) {
      cur[0] = i;
      for (j = 1; j <= n; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
      var t = prev; prev = cur; cur = t;
    }
    return 1 - prev[n] / Math.max(m, n);
  }

  function isSpecialToken(text) {
    return /^\s*\[_[A-Z_]+/.test(text) || /^\s*\[_?\w*\]\s*$/.test(text);
  }

  // whisper-cli JSON → [{ f, t, p }]
  function transcriptWords(transcript, opts) {
    var words = [];
    var segments = (transcript && transcript.transcription) || [];
    for (var s = 0; s < segments.length; s++) {
      var tokens = segments[s].tokens || [];
      for (var k = 0; k < tokens.length; k++) {
        var tok = tokens[k];
        var text = tok.text || "";
        if (isSpecialToken(text)) continue;
        var t = typeof tok.t_dtw === "number" && tok.t_dtw >= 0
          ? tok.t_dtw / 100
          : ((tok.offsets && tok.offsets.from) || 0) / 1000;
        var p = typeof tok.p === "number" ? tok.p : 1;
        var last = words[words.length - 1];
        if (/^\s/.test(text) || !last) {
          words.push({ raw: text.trim(), t: t, pSum: p, n: 1 });
        } else {
          if (last.n === 1 && t - last.t > opts.strandedSecs) last.t = t;
          last.raw += text;
          last.pSum += p;
          last.n++;
        }
      }
    }
    var out = [];
    for (var w = 0; w < words.length; w++) {
      var f = fold(words[w].raw);
      if (f) out.push({ f: f, t: words[w].t, p: words[w].pSum / words[w].n });
    }
    return out;
  }

  // A line that is only a section label ("[Chorus]", "(x2)") isn't sung and
  // would read as an LRC tag, so it's left out of the result.
  function isLabelLine(line) {
    return /^\s*[\[(][^\])]*[\])]\s*$/.test(line);
  }

  function lyricLines(text) {
    return String(text)
      .replace(/\r\n?/g, "\n")
      .split("\n")
      .map(function (l) { return l.trim(); })
      .filter(function (l) { return l && !isLabelLine(l); });
  }

  var EPS = 1e-9;

  function align(lyrics, hyp, opts) {
    var N = lyrics.length, M = hyp.length, W = M + 1;
    var S = new Float64Array((N + 1) * W);
    var B = new Uint8Array((N + 1) * W); // 0 diag, 1 skip lyric, 2 skip transcript
    var i, j;
    for (i = 1; i <= N; i++) { S[i * W] = i * opts.lyricGap; B[i * W] = 1; }
    for (j = 1; j <= M; j++) { S[j] = 0; B[j] = 2; } // free leading transcript
    for (i = 1; i <= N; i++) {
      for (j = 1; j <= M; j++) {
        var sim = similarity(lyrics[i - 1].f, hyp[j - 1].f);
        var weight = 0.5 + 0.5 * hyp[j - 1].p;
        var diag = S[(i - 1) * W + j - 1] + (sim >= opts.minSimilarity ? 2 * sim * weight : -1);
        var up = S[(i - 1) * W + j] + opts.lyricGap;
        var left = S[i * W + j - 1] + opts.transcriptGap;
        var c = i * W + j;
        // On a tie with skipping transcript, skip it: the backtrack then
        // matches the earlier of two equal copies (a chorus the lyrics write
        // once and the singer repeats shows from its first singing).
        // Scores are float sums, so equal paths can differ in the last digits.
        if (diag > left + EPS && diag >= up - EPS) { S[c] = diag; B[c] = 0; }
        else if (up > left + EPS) { S[c] = up; B[c] = 1; }
        else { S[c] = left; B[c] = 2; }
      }
    }
    // Free trailing transcript: end at the best cell of the last row.
    var jEnd = 0;
    for (j = 0; j <= M; j++) if (S[N * W + j] > S[N * W + jEnd] + EPS) jEnd = j;
    var match = new Array(N);
    for (i = 0; i < N; i++) match[i] = -1;
    i = N; j = jEnd;
    while (i > 0 && j > 0) {
      var b = B[i * W + j];
      if (b === 0) {
        if (similarity(lyrics[i - 1].f, hyp[j - 1].f) >= opts.minSimilarity) match[i - 1] = j - 1;
        i--; j--;
      } else if (b === 1) i--;
      else j--;
    }
    return match;
  }

  function formatLrcTime(secs) {
    var cs = Math.max(0, Math.round(secs * 100));
    var m = Math.floor(cs / 6000);
    var s = Math.floor((cs % 6000) / 100);
    var c = cs % 100;
    return "[" + (m < 10 ? "0" : "") + m + ":" + (s < 10 ? "0" : "") + s + "." + (c < 10 ? "0" : "") + c + "]";
  }

  /**
   * @param {string} plainLyrics  the song's plain lyrics, one line per line
   * @param {object} transcript   parsed `whisper-cli -ojf` JSON
   * @param {object} [options]    see DEFAULTS; plus `durationSecs` to clamp to
   * @returns {{ lines: {text: string, start: number, anchored: boolean}[],
   *             lrc: string, anchoredRatio: number }}
   */
  function alignLyrics(plainLyrics, transcript, options) {
    var opts = {};
    var key;
    for (key in DEFAULTS) opts[key] = DEFAULTS[key];
    for (key in options || {}) opts[key] = options[key];

    var lines = lyricLines(plainLyrics);
    var lyricWords = [];
    lines.forEach(function (line, li) {
      var pos = 0;
      line.split(/\s+/).forEach(function (w) {
        var f = fold(w);
        if (f) lyricWords.push({ f: f, line: li, pos: pos++ });
      });
    });
    var hyp = transcriptWords(transcript, opts);
    if (!lines.length || !lyricWords.length || !hyp.length) {
      return { lines: lines.map(function (text) { return { text: text, start: 0, anchored: false }; }), lrc: "", anchoredRatio: 0 };
    }

    var match = align(lyricWords, hyp, opts);
    var starts = lines.map(function () { return null; });
    lyricWords.forEach(function (w, k) {
      if (starts[w.line] === null && match[k] >= 0 && w.pos <= 1) starts[w.line] = hyp[match[k]].t;
    });
    // Alignment is monotone, but a line anchored on its second word can still
    // land before the previous line's start: drop such an anchor.
    var lastAnchor = -Infinity;
    for (var a = 0; a < starts.length; a++) {
      if (starts[a] === null) continue;
      if (starts[a] <= lastAnchor) starts[a] = null;
      else lastAnchor = starts[a];
    }
    var anchored = starts.map(function (s) { return s !== null; });
    var anchoredCount = anchored.filter(Boolean).length;

    for (var x = 0; x < starts.length; x++) {
      if (starts[x] !== null) continue;
      var lo = x - 1; while (lo >= 0 && !anchored[lo]) lo--;
      var hi = x + 1; while (hi < starts.length && !anchored[hi]) hi++;
      var tLo = lo >= 0 ? starts[lo] : null;
      var tHi = hi < starts.length ? starts[hi] : null;
      if (tLo !== null && tHi !== null) starts[x] = tLo + ((tHi - tLo) * (x - lo)) / (hi - lo);
      else if (tHi !== null) starts[x] = Math.max(0, tHi - opts.fallbackLineSecs * (hi - x));
      else if (tLo !== null) starts[x] = tLo + opts.fallbackLineSecs * (x - lo);
      else starts[x] = 0;
    }

    var out = lines.map(function (text, li) {
      var t = Math.max(0, starts[li] - opts.leadSecs);
      if (typeof opts.durationSecs === "number") t = Math.min(t, opts.durationSecs);
      return { text: text, start: Math.round(t * 100) / 100, anchored: anchored[li] };
    });
    // Keep the order strict after rounding and the lead.
    for (var y = 1; y < out.length; y++) {
      if (out[y].start <= out[y - 1].start) out[y].start = Math.round((out[y - 1].start + 0.01) * 100) / 100;
    }
    return {
      lines: out,
      lrc: out.map(function (l) { return formatLrcTime(l.start) + l.text; }).join("\n"),
      anchoredRatio: anchoredCount / lines.length,
    };
  }

  // ------------------------------------------------------------ transcription
  //
  // A transcript (no lyrics to align against) turned into timed lines, for a
  // video or a song the user asked to transcribe. One whisper segment is one
  // line (run whisper-cli with `-ml <chars> -sow` so segments are subtitle
  // sized). Rules:
  //   - Non-speech segments ("[Music]", "(laughs)", "♪") are left out: they
  //     aren't speech, and a line starting with "[" reads as an LRC tag.
  //   - Whisper can loop on the same sentence over silence; a line equal to
  //     the two before it is dropped.
  //   - A pause longer than `gapSecs` gets an empty line at the end of the
  //     segment, so the subtitle clears instead of hanging over the silence.
  //   - LRC minutes have two digits: nothing at or past 100:00 is written.
  //   - With `durationSecs`, a closing empty line is put at the end of the
  //     media. The transcript covers the whole file, and the app only shows
  //     synced lines over a video when they reach 60% of its length.

  var TRANSCRIPT_DEFAULTS = { gapSecs: 1.5, maxSecs: 5999.99 };

  function isNonSpeech(text) {
    var t = text.replace(/[♪♫\s]/g, "");
    if (!t) return true;
    return /^(\[[^\]]*\]|\([^)]*\)|\*[^*]*\*)+$/.test(t);
  }

  /**
   * @param {object} transcript  parsed `whisper-cli -ojf` JSON
   * @param {object} [options]   gapSecs, maxSecs, durationSecs
   * @returns {{ lrc: string, lines: number, lastSecs: number }}
   *   `lines` counts spoken lines only (not the clearing empty ones).
   */
  function transcriptLrc(transcript, options) {
    var opts = {};
    var key;
    for (key in TRANSCRIPT_DEFAULTS) opts[key] = TRANSCRIPT_DEFAULTS[key];
    for (key in options || {}) opts[key] = options[key];

    var segments = (transcript && transcript.transcription) || [];
    var kept = [];
    for (var s = 0; s < segments.length; s++) {
      var seg = segments[s];
      var text = String(seg.text || "").replace(/\s+/g, " ").trim();
      if (!text || isNonSpeech(text)) continue;
      var from = ((seg.offsets && seg.offsets.from) || 0) / 1000;
      var to = ((seg.offsets && seg.offsets.to) || 0) / 1000;
      if (to < from) to = from;
      if (from > opts.maxSecs) break;
      var f = fold(text);
      var n = kept.length;
      if (n >= 2 && kept[n - 1].f === f && kept[n - 2].f === f) continue;
      kept.push({ text: text, f: f, from: from, to: Math.min(to, opts.maxSecs) });
    }

    var out = [];
    var last = -1;
    function push(t, text) {
      t = Math.round(Math.max(t, 0) * 100) / 100;
      if (t <= last) t = Math.round((last + 0.01) * 100) / 100;
      if (t > opts.maxSecs) return;
      out.push(formatLrcTime(t) + text);
      last = t;
    }
    for (var k = 0; k < kept.length; k++) {
      push(kept[k].from, kept[k].text);
      var next = k + 1 < kept.length ? kept[k + 1].from : Infinity;
      if (next - kept[k].to > opts.gapSecs) push(kept[k].to, "");
    }
    if (kept.length && typeof opts.durationSecs === "number" && opts.durationSecs > last) {
      push(opts.durationSecs, "");
    }
    return { lrc: out.join("\n"), lines: kept.length, lastSecs: kept.length ? kept[kept.length - 1].to : 0 };
  }

  var api = { alignLyrics: alignLyrics, transcriptLrc: transcriptLrc, fold: fold, similarity: similarity, formatLrcTime: formatLrcTime, lyricLines: lyricLines };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.WhisperAlign = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
