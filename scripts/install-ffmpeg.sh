#!/usr/bin/env bash
# Install FFmpeg on a GitHub runner without depending on Ubuntu's package mirrors,
# which occasionally hang for hours. Order:
#   1. a copy cached from an earlier run (restored to ~/ffmpeg-bin by actions/cache)
#   2. a ready-made static build from GitHub (BtbN/FFmpeg-Builds)
#   3. Ubuntu's apt, with a time limit and retries
# Each attempt has its own time limit, so a stall fails in minutes, not hours.
set -uo pipefail

BIN="$HOME/ffmpeg-bin"
mkdir -p "$BIN"

use() {
  echo "$1" >> "$GITHUB_PATH"
  export PATH="$1:$PATH"
  ffmpeg -version | head -1
  ffprobe -version | head -1 >/dev/null
}

if [ -x "$BIN/ffmpeg" ] && [ -x "$BIN/ffprobe" ] && "$BIN/ffmpeg" -version >/dev/null 2>&1; then
  echo "Using cached FFmpeg"
  use "$BIN"; exit 0
fi

for url in \
  "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-n7.1-latest-linux64-gpl-7.1.tar.xz" \
  "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linux64-gpl.tar.xz"; do
  echo "Downloading $url"
  tmp="$(mktemp -d)"
  if timeout 180 curl -fsSL --retry 3 --retry-delay 5 --connect-timeout 20 "$url" -o "$tmp/ff.tar.xz" \
     && tar -xJf "$tmp/ff.tar.xz" -C "$tmp" \
     && cp "$tmp"/ffmpeg-*/bin/ffmpeg "$tmp"/ffmpeg-*/bin/ffprobe "$BIN/" \
     && "$BIN/ffmpeg" -version >/dev/null 2>&1; then
    rm -rf "$tmp"
    echo "Using static FFmpeg"
    use "$BIN"; exit 0
  fi
  rm -rf "$tmp"
  echo "That download didn't work; trying the next option."
done

echo "Falling back to Ubuntu packages"
export DEBIAN_FRONTEND=noninteractive
for attempt in 1 2; do
  if timeout 240 sudo -E apt-get -o Acquire::Retries=3 -o Acquire::http::Timeout=30 update -qq \
     && timeout 300 sudo -E apt-get -o Acquire::Retries=3 -o Acquire::http::Timeout=30 install -y -qq ffmpeg >/dev/null; then
    ffmpeg -version | head -1
    exit 0
  fi
  echo "apt attempt $attempt failed"
done

echo "::error::Couldn't install FFmpeg (GitHub download and Ubuntu packages both failed). Try the run again in a few minutes."
exit 1
