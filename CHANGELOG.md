# Changelog

## 0.3.0

Needs Vibo 1.0.124 or later.

- **You check every result before it's saved.** A sync or a transcription you start now makes a draft. **Review** opens it in Vibo's lyrics editor on the track's page, with a note on what to check: the lines Whisper had to guess, or a warning when few lines matched. Fix the words, nudge the times with Sync, then Save. Discard leaves the track's lyrics as they were. Drafts waiting are listed in the settings under **Ready to review**.
- **Synced lyrics that are off can be fixed.** **Sync lyrics with Whisper** on a track with synced lyrics drops the old times and times the same words again.
- **Sync lyrics with Whisper** also transcribes a track that has no lyrics at all, so it covers every track that should keep (or get) its words.
- **Transcribe with Whisper** now works on any track, lyrics or not: for lyrics that are wrong, or a video's subtitles. The review decides whether the transcript replaces anything.
- Lyrics that come from the song's own file can now be timed; your Save puts them back in the file.
- A track whose lyrics couldn't be read (a provider was down) isn't timed or transcribed by Sync; it fails with that reason.
- **Progress, redone.** The settings show what's being worked on at the top: each track with its step, a progress bar, the time so far and, once Whisper is listening, about how long is left. Tracks waiting are listed below it, each with Cancel, plus **Cancel all**. Cancel works at every step. **Show progress** opens the settings scrolled to that list.
- Several tracks at once give one notice when the work starts and one summary at the end ("Finished 5 tracks: 4 ready to review, 1 skipped."), instead of one per track.
- When whisper-cli or the model is missing, the menu says so once, with **Set up**, instead of a failure per track.
- Recent shows each outcome as a coloured chip, with **Try again** on failed and cancelled tracks, and **Clear**.
- Automatic syncing and the assistant's `sync_lyrics` still save directly (plain lyrics, at least 70% matched). The assistant's `transcribe` now makes a draft for you to review.

## 0.2.1

- Fixed: jobs failed before Whisper started, because ffmpeg was given no file to write the audio to.
- A sync or transcription you start says so, with **Show progress** to open the plugin's settings, where its progress is shown.
- Settings: one **Model** row to choose the model, saying whether it's downloaded. The Download button shows only while it isn't.

## 0.2.0

- New: **Transcribe with Whisper**. Right-click a track that has no lyrics at all, such as a talk, an interview or a video, and Whisper writes down what it hears as synced lyrics. For a video they show as its subtitles; turn them on with the subtitle button over the video.
- Transcription runs only when you ask for it. It never replaces lyrics a track already has (a track with plain lyrics is pointed at **Sync lyrics with Whisper** instead), and automatic mode never transcribes.
- Lines are subtitle-sized. The subtitle clears during long pauses, and non-speech markers such as "[Music]" are left out.
- Assistant tool `transcribe`.

## 0.1.1

- The settings panel shows whisper-cli as installed as soon as the install finishes, however long the install dialog was left open, and also when it is installed from Extensions → Tools. Needs a Vibo release with `api.system.onDependencyInstalled`; on older versions the panel re-checks for five minutes after Install, as before.

## 0.1.0

- First release. Right-click a song (or several) and choose **Sync lyrics with Whisper**: the song's plain lyrics get timings from its audio and are saved as synced lyrics.
- Only lyrics the song already has are timed. A song with none is skipped, and nothing Whisper hears is saved as lyrics.
- Nothing is saved unless at least 70% of the lines matched what was sung.
- Local files only. Songs whose lyrics come from their own file are skipped in this version.
- Optional **Sync automatically** (off by default): times the lyrics of a song with plain lyrics when it starts playing, once per song.
- whisper-cli is installed from Extensions → Tools; the model (574 MB, or a 190 MB smaller one) is downloaded from the plugin's settings.
- Assistant tool `sync_lyrics`.
