# assets/voicelines/ — post-stage voice lines

Drop your voice-clip files in this folder, then regenerate the manifest:

```bash
./scripts/build_audio_manifests.sh
```

- **Supported formats:** `.mp3` and `.wav` (also `.m4a`, `.ogg`, `.flac`, `.aac`).
- The script writes `manifest.json` here — a list of `{ file, title }`.
- After each stage (and on game over) one clip plays, picked **randomly with no
  repeats** until the pool is exhausted, then reshuffled.
- Voice lines obey the in-game sound toggle (the speaker button), the same as the
  other game sound effects. They are independent of the radio's own mute.
- Hearing voice lines unlocks achievements (1 / 5 / all).

Nothing plays until `manifest.json` lists at least one clip, so an empty manifest
is safe to commit before you've added voice lines.
