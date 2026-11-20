# Changelog

## 0.1.0

- First release. Right-click a song (or several) and choose **Sync lyrics with Whisper**: the song's plain lyrics get timings from its audio and are saved as synced lyrics.
- Only lyrics the song already has are timed. A song with none is skipped, and nothing Whisper hears is saved as lyrics.
- Nothing is saved unless at least 70% of the lines matched what was sung.
- Local files only. Songs whose lyrics come from their own file are skipped in this version.
- Optional **Sync automatically** (off by default): times the lyrics of a song with plain lyrics when it starts playing, once per song.
- whisper-cli is installed from Extensions → Tools; the model (574 MB, or a 190 MB smaller one) is downloaded from the plugin's settings.
- Assistant tool `sync_lyrics`.
