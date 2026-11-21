# Changelog

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
