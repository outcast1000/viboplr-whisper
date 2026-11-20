# viboplr-whisper

A [Vibo](https://github.com/outcast1000/viboplr) plugin that times a song's plain lyrics from its audio with [whisper.cpp](https://github.com/ggml-org/whisper.cpp), so a song with plain lyrics gets synced ones. Work in progress.

- It only adds timings to lyrics the song already has. A song with no lyrics is skipped; whisper's transcription is never saved as lyrics.
- Local files only for now.
- `whisper-cli` and the models come from [viboplr-whisper-cpp](https://github.com/outcast1000/viboplr-whisper-cpp).

## Files

| File | What it is |
|---|---|
| `align.js` | Lines up the plain lyrics with whisper's word timestamps and gives each line a start time. Pure; see the comment at its top. |
| `plugin.js` | The plugin: the menu item, the job (ffmpeg → whisper-cli → align → save), automatic mode, the settings panel, the assistant tool. |
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
