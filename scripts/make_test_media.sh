#!/usr/bin/env bash
# Generates the small synthetic media set used by the verification harnesses.
# Requires ffmpeg. Everything is created locally — nothing is downloaded.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$REPO_ROOT/test-media"

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "ffmpeg is required to generate the test media (brew install ffmpeg)" >&2
  exit 1
fi

mkdir -p "$OUT"

# 4-second 640x360 test pattern with an audio track.
ffmpeg -y -loglevel error \
  -f lavfi -i "testsrc=size=640x360:rate=25:duration=4" \
  -f lavfi -i "sine=frequency=440:duration=4" \
  -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest "$OUT/vid1.mp4"

# 3-second 640x360 colour bars.
ffmpeg -y -loglevel error \
  -f lavfi -i "smptebars=size=640x360:rate=25:duration=3" \
  -c:v libx264 -pix_fmt yuv420p "$OUT/vid2.mp4"

# 5-second tone, used as BGM.
ffmpeg -y -loglevel error \
  -f lavfi -i "sine=frequency=880:duration=5" \
  -c:a libmp3lame "$OUT/bgm.mp3"

echo "Test media written to $OUT"
ls -1 "$OUT"
