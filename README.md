# viboplr-whisper

A [Vibo](https://github.com/outcast1000/viboplr) plugin that times a song's plain lyrics from its audio with [whisper.cpp](https://github.com/ggml-org/whisper.cpp), so a song with plain lyrics gets synced ones. Work in progress.

- It only adds timings to lyrics the song already has. A song with no lyrics is skipped; whisper's transcription is never saved as lyrics.
- Local files only for now.
- `whisper-cli` and the models come from [viboplr-whisper-cpp](https://github.com/outcast1000/viboplr-whisper-cpp).

## Files

| File | What it is |
|---|---|
| `align.js` | Lines up the plain lyrics with whisper's word timestamps and gives each line a start time. Pure; see the comment at its top. |
| `test/` | `npm test` (Node's built-in runner, no dependencies). The tests use invented lyrics, never real ones. |

## License

MIT.
