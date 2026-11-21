# viboplr-whisper

A [Vibo](https://github.com/outcast1000/viboplr) plugin that times a song's plain lyrics from its audio with [whisper.cpp](https://github.com/ggml-org/whisper.cpp), so a song with plain lyrics gets synced ones. Work in progress.

Two menu items, for four situations:

| The track has | Use | Whisper |
|---|---|---|
| No lyrics, and you want synced ones | **Sync lyrics with Whisper** | transcribes what it hears |
| Plain lyrics | **Sync lyrics with Whisper** | times them |
| Synced lyrics that are off | **Sync lyrics with Whisper** | drops the old times and times the same words again |
| Lyrics that are wrong, or a video that needs subtitles | **Transcribe with Whisper** | writes down what it hears, whatever the track has |

- **Every result is a draft you check first.** It opens in Vibo's lyrics editor on the track's page, with a note on what to check (lines it had to guess, a poor match). Edit the words, use Sync to replay a line and nudge its time, then **Save**. Nothing replaces a track's lyrics until you do. Drafts waiting are listed in the plugin's settings under **Ready to review**.
- **Sync automatically** (off by default) is the exception: nobody is there to review, so it only times plain lyrics, and saves them only when at least 70% of the lines matched. It never transcribes and never touches synced lyrics. The assistant's `sync_lyrics` tool follows the same rules; its `transcribe` tool makes a draft.
- Progress is shown at the top of the plugin's settings (Extensions → Whisper → Configuration), which the start notice's **Show progress** opens.
- Local files only for now.
- `whisper-cli` and the models come from [viboplr-whisper-cpp](https://github.com/outcast1000/viboplr-whisper-cpp).

## Files

| File | What it is |
|---|---|
| `align.js` | Lines up the plain lyrics with whisper's word timestamps and gives each line a start time (`alignLyrics`), and turns a transcript into timed subtitle lines (`transcriptLrc`). Pure; see the comments in it. |
| `plugin.js` | The plugin: the menu items, the two jobs (ffmpeg → whisper-cli → align or transcribe → save), automatic mode, the settings panel, the assistant tools. |
| `index.js` | **Generated** by `node scripts/build.mjs` from the two files above — the one file Vibo loads. Edit those, never this; CI fails when it is stale. |
| `manifest.json` | Permissions, the `whisper-cli` tool definition, contributions. |
| `test/` | `npm test` (Node's built-in runner, no dependencies). `plugin.test.js` runs the built `index.js` against a fake host. The tests use invented lyrics, never real ones. |
| `scripts/package.sh` | Builds, tests, signs (when the key is set) and zips `whisper.zip` + `update.json`. |

## Releasing

Bump `version` in `manifest.json`, add a `## <version>` section to `CHANGELOG.md`, commit, then `git tag v<version> && git push origin v<version>`. The Release workflow builds, signs and publishes; never create the release by hand. It needs the repo secret `TAURI_SIGNING_PRIVATE_KEY` (the Vibo plugin-signing key, never the app updater key).

## Trying it in Vibo before a release

Turn on Debug mode, set the dev plugin folder to this repo, and run `node scripts/build.mjs` after each change (Reload on the plugin's Dev banner).

## License

MIT.
