#!/bin/bash
# Regenerates the audio manifests by scanning the asset folders:
#   assets/music/      -> assets/music/manifest.json      (album + tracks, with durations)
#   assets/voicelines/ -> assets/voicelines/manifest.json (post-stage voice clips)
#
# Drop audio files into those folders, then run this with no arguments.
# Song durations are read via ffprobe, falling back to macOS `afinfo`, and are
# omitted (the player uses a default) if neither tool is present.
#
# Override the album title with: ALBUM_TITLE="My Album" ./scripts/build_audio_manifests.sh
set -euo pipefail
cd "$(dirname "$0")/.."

ALBUM_TITLE="${ALBUM_TITLE:-Drunk Boy Parade}"
AUDIO_EXTS="mp3 m4a wav ogg oga flac aac"

json_escape() {
  local s=$1
  s=${s//\\/\\\\}
  s=${s//\"/\\\"}
  s=${s//$'\t'/\\t}
  s=${s//$'\r'/\\r}
  s=${s//$'\n'/\\n}
  printf '%s' "$s"
}

# Filename -> display title: strip extension, drop a leading track number like
# "01-" or "03_ ", turn separators into spaces, collapse runs of whitespace.
title_from() {
  local base=$1
  base=${base%.*}
  base=$(printf '%s' "$base" | sed -E 's/^[0-9]+[[:space:]]*[-_.][[:space:]]*//')
  base=${base//_/ }
  base=${base//-/ }
  printf '%s' "$base" | sed -E 's/[[:space:]]+/ /g; s/^ //; s/ $//'
}

duration_of() {
  local f=$1 d=""
  if command -v ffprobe >/dev/null 2>&1; then
    d=$(ffprobe -v quiet -show_entries format=duration -of csv=p=0 "$f" 2>/dev/null || true)
  fi
  if [ -z "$d" ] && command -v afinfo >/dev/null 2>&1; then
    d=$(afinfo "$f" 2>/dev/null | sed -nE 's/.*estimated duration: ([0-9.]+) sec.*/\1/p' | head -n1 || true)
  fi
  case "$d" in
    ''|*[!0-9.]*) d="" ;;   # keep only a bare positive number
  esac
  printf '%s' "$d"
}

list_audio() {
  local dir=$1 f ext
  [ -d "$dir" ] || return 0
  for f in "$dir"/*; do
    [ -f "$f" ] || continue
    ext=$(printf '%s' "${f##*.}" | tr '[:upper:]' '[:lower:]')
    case " $AUDIO_EXTS " in
      *" $ext "*) printf '%s\n' "$f" ;;
    esac
  done | sort
}

build_music() {
  local dir="assets/music" out="assets/music/manifest.json"
  [ -d "$dir" ] || { echo "skip music: $dir/ not found"; return 0; }
  local body="" sep="" f base title dur entry count=0
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    base=$(basename "$f")
    title=$(title_from "$base")
    dur=$(duration_of "$f")
    entry="    { \"file\": \"$(json_escape "$base")\", \"title\": \"$(json_escape "$title")\""
    [ -n "$dur" ] && entry="$entry, \"duration\": $dur"
    entry="$entry }"
    body="$body$sep$entry"
    sep=$',\n'
    count=$((count + 1))
  done < <(list_audio "$dir")
  {
    printf '{\n'
    printf '  "album": "%s",\n' "$(json_escape "$ALBUM_TITLE")"
    printf '  "tracks": [\n'
    [ -n "$body" ] && printf '%s\n' "$body"
    printf '  ]\n'
    printf '}\n'
  } > "$out"
  echo "wrote $out ($count track(s))"
}

build_voice() {
  local dir="assets/voicelines" out="assets/voicelines/manifest.json"
  [ -d "$dir" ] || { echo "skip voice: $dir/ not found"; return 0; }
  local body="" sep="" f base title entry count=0
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    base=$(basename "$f")
    title=$(title_from "$base")
    entry="    { \"file\": \"$(json_escape "$base")\", \"title\": \"$(json_escape "$title")\" }"
    body="$body$sep$entry"
    sep=$',\n'
    count=$((count + 1))
  done < <(list_audio "$dir")
  {
    printf '{\n'
    printf '  "clips": [\n'
    [ -n "$body" ] && printf '%s\n' "$body"
    printf '  ]\n'
    printf '}\n'
  } > "$out"
  echo "wrote $out ($count clip(s))"
}

build_music
build_voice
