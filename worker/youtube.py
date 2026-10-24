"""Upload a rendered video to YouTube as a private video (nothing is published).

Uses the same Google OAuth app as Drive, but its own refresh token, because the
YouTube channel can belong to a different Google account than the Drive folder
(for testing it's Jacob's own channel; later the church's).

Needs: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET (shared with Drive) and
YOUTUBE_REFRESH_TOKEN (made with the youtube.upload scope).
Optional variable: YOUTUBE_CATEGORY (default 29, "Nonprofits & Activism").
"""

from __future__ import annotations

import os
import subprocess
import time
from pathlib import Path

import requests

TOKEN_URL = "https://oauth2.googleapis.com/token"
UPLOAD_URL = "https://www.googleapis.com/upload/youtube/v3/videos"
THUMB_URL = "https://www.googleapis.com/upload/youtube/v3/thumbnails/set"
CHUNK = 64 * 1024 * 1024          # multiple of 256 KiB
RETRIES = 6
TITLE_MAX = 100
DESC_MAX = 5000
THUMB_MAX = 2 * 1024 * 1024       # YouTube's limit for custom thumbnails


class YouTubeError(Exception):
    pass


def missing_settings() -> list[str]:
    return [k for k in ("GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "YOUTUBE_REFRESH_TOKEN")
            if not os.environ.get(k, "").strip()]


def _access_token() -> str:
    r = requests.post(TOKEN_URL, timeout=30, data={
        "client_id": os.environ["GOOGLE_CLIENT_ID"].strip(),
        "client_secret": os.environ["GOOGLE_CLIENT_SECRET"].strip(),
        "refresh_token": os.environ["YOUTUBE_REFRESH_TOKEN"].strip(),
        "grant_type": "refresh_token",
    })
    if r.status_code != 200:
        try:
            detail = r.json().get("error_description") or r.json().get("error")
        except ValueError:
            detail = r.status_code
        raise YouTubeError(f"YouTube sign-in failed ({detail}). Check the YOUTUBE_REFRESH_TOKEN secret.")
    return r.json()["access_token"]


def _explain(r: requests.Response) -> str:
    try:
        err = r.json().get("error", {})
        reason = (err.get("errors") or [{}])[0].get("reason", "")
        msg = err.get("message", "")
    except ValueError:
        reason, msg = "", r.text[:200]
    hints = {
        "quotaExceeded": "The daily YouTube upload limit for this Google project was reached; try again tomorrow.",
        "uploadLimitExceeded": "This channel hit YouTube's upload limit for now; try again later.",
        "youtubeSignupRequired": "The signed-in Google account has no YouTube channel yet.",
        "forbidden": "The token isn't allowed to upload. Make it again with the youtube.upload scope.",
        "insufficientPermissions": "The token isn't allowed to upload. Make it again with the youtube.upload scope.",
    }
    return hints.get(reason) or f"YouTube said {r.status_code}: {msg or reason}"


def clean_title(title: str) -> str:
    # YouTube rejects < and > in titles, and titles over 100 characters.
    t = " ".join(title.replace("<", "").replace(">", "").split())
    return (t[:TITLE_MAX - 1].rstrip() + "…") if len(t) > TITLE_MAX else t


def upload(video: Path, title: str, description: str, *, token: str | None = None,
           on_bytes=None, progress=print) -> str:
    """Upload as private and return the video id."""
    token = token or _access_token()
    size = video.stat().st_size
    meta = {
        "snippet": {
            "title": clean_title(title) or video.stem,
            "description": description.replace("<", "").replace(">", "")[:DESC_MAX],
            "categoryId": os.environ.get("YOUTUBE_CATEGORY", "").strip() or "29",
        },
        "status": {"privacyStatus": "private", "selfDeclaredMadeForKids": False},
    }
    auth = {"Authorization": f"Bearer {token}"}
    r = requests.post(UPLOAD_URL, params={"uploadType": "resumable", "part": "snippet,status"},
                      headers={**auth, "X-Upload-Content-Type": "video/*", "X-Upload-Content-Length": str(size)},
                      json=meta, timeout=60)
    if r.status_code != 200:
        raise YouTubeError(_explain(r))
    session = r.headers["Location"]

    sent, failures, next_mark = 0, 0, 25
    with video.open("rb") as fh:
        while True:
            fh.seek(sent)
            data = fh.read(CHUNK)
            try:
                r = requests.put(session, data=data, timeout=900, headers={
                    **auth, "Content-Range": f"bytes {sent}-{sent + len(data) - 1}/{size}"})
                if r.status_code in (500, 502, 503, 504):
                    raise requests.ConnectionError(f"server error {r.status_code}")
            except requests.RequestException:
                failures += 1
                if failures > RETRIES:
                    raise YouTubeError("The YouTube upload kept failing; the connection dropped too many times.")
                time.sleep(2 ** failures)
                # Ask how much YouTube actually received, then carry on from there.
                r = requests.put(session, headers={**auth, "Content-Range": f"bytes */{size}"}, timeout=60)
            if r.status_code in (200, 201):
                progress(f"    YouTube upload {video.name}: 100%")
                return r.json()["id"]
            if r.status_code == 401:          # token expired during a long upload
                token = _access_token()
                auth = {"Authorization": f"Bearer {token}"}
                continue
            if r.status_code != 308:
                raise YouTubeError(_explain(r))
            rng = r.headers.get("Range")
            sent = int(rng.split("-")[1]) + 1 if rng else 0
            if on_bytes:
                on_bytes(sent, size)
            if size and sent * 100 // size >= next_mark:
                progress(f"    YouTube upload {video.name}: {sent * 100 // size}%")
                next_mark = sent * 100 // size // 25 * 25 + 25


def thumbnail_jpeg(image: Path, dest: Path) -> Path:
    """1280×720 JPEG under YouTube's 2 MB limit (PNG thumbnails are often bigger)."""
    for q in (2, 4, 7, 10):
        subprocess.run(["ffmpeg", "-hide_banner", "-v", "error", "-y", "-i", str(image), "-vf",
                        "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2",
                        "-frames:v", "1", "-q:v", str(q), str(dest)], check=True)
        if dest.stat().st_size <= THUMB_MAX:
            return dest
    return dest


def set_thumbnail(video_id: str, image: Path, *, token: str | None = None) -> None:
    token = token or _access_token()
    r = requests.post(THUMB_URL, params={"videoId": video_id}, data=image.read_bytes(), timeout=120,
                      headers={"Authorization": f"Bearer {token}", "Content-Type": "image/jpeg"})
    if r.status_code == 403:
        raise YouTubeError("YouTube wouldn't take the thumbnail. Custom thumbnails need a verified channel "
                           "(youtube.com/verify).")
    if r.status_code != 200:
        raise YouTubeError(_explain(r))


def studio_link(video_id: str) -> str:
    return f"https://studio.youtube.com/video/{video_id}/edit"
