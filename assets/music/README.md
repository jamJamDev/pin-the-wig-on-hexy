# assets/music/ — the radio station's album

Drop your song files in this folder, then regenerate the manifest:

```bash
./scripts/build_audio_manifests.sh
```

- **Supported formats:** `.mp3` and `.wav` (also `.m4a`, `.ogg`, `.flac`, `.aac`).
- The script writes `manifest.json` here — a list of `{ file, title, duration }`
  plus an `album` name. The player and the **Download album** button both read it.
- Durations come from `ffprobe` (or macOS `afinfo`). If neither is installed the
  duration is omitted and the player falls back to a default length per track.
- Track order is **shuffled fresh each day** (deterministic — everyone hears the
  same order on a given day) and the station position is derived from the clock,
  so the album plays like an always-on radio station.

The player stays hidden until `manifest.json` lists at least one track, so it's
safe to commit an empty manifest before you've added music.

Set a custom album title:

```bash
ALBUM_TITLE="My Mixtape" ./scripts/build_audio_manifests.sh
```
