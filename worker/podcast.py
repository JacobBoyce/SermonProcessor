"""Save a rendered podcast MP3 as a draft episode in the R2 bucket.

The web app lists drafts, lets a person edit the title and description, and
publishes them into the feed. Nothing here touches the public feed itself.

Bucket layout (all under "podcast/"):
    podcast/audio/<id>.mp3        episode audio
    podcast/images/<id>.jpg       square episode cover (from the video's thumbnail)
    podcast/draft.json            the next episode waiting to be published (one at a time;
                                  a new render replaces it)
    podcast/episodes.json         published episodes (written by the web app)
    podcast/show.json             show details (written by the web app)

Needs: R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY (secrets), R2_ENDPOINT, R2_BUCKET (variables).
"""

from __future__ import annotations

import json
import os
import subprocess
import time
import uuid
from pathlib import Path

SETTINGS = ("R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_ENDPOINT", "R2_BUCKET")
COVER_SIZE = 1400          # Apple's minimum for square artwork; small enough to load fast


class PodcastError(Exception):
    pass


def missing_settings() -> list[str]:
    return [k for k in SETTINGS if not os.environ.get(k, "").strip()]


def _client():
    import boto3   # installed by the workflow
    from botocore.config import Config
    return boto3.client(
        "s3",
        endpoint_url=os.environ["R2_ENDPOINT"].strip(),
        aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"].strip(),
        aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"].strip(),
        region_name="auto",
        config=Config(retries={"max_attempts": 5, "mode": "standard"}, signature_version="s3v4"),
    )


def square_cover(image: Path, dest: Path) -> Path:
    """Fit a (usually 16:9) thumbnail into a square, filling the sides with a blurred copy."""
    s = COVER_SIZE
    graph = (f"[0:v]scale={s}:{s}:force_original_aspect_ratio=increase,crop={s}:{s},boxblur=40:5,eq=brightness=-0.08[bg];"
             f"[0:v]scale={s}:{s}:force_original_aspect_ratio=decrease[fg];"
             f"[bg][fg]overlay=(W-w)/2:(H-h)/2,format=yuvj420p")
    subprocess.run(["ffmpeg", "-hide_banner", "-v", "error", "-y", "-i", str(image), "-filter_complex", graph,
                    "-frames:v", "1", "-q:v", "3", str(dest)], check=True)
    return dest


def duration_of(media: Path) -> float:
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(media)],
                         capture_output=True, text=True)
    try:
        return float(out.stdout.strip())
    except ValueError:
        return 0.0


def save_draft(mp3: Path, cover: Path | None, title: str, description: str, source: str,
               output_name: str, work: Path, client=None) -> dict:
    """Upload the episode files and its draft record. Returns the draft."""
    missing = missing_settings()
    if missing:
        raise PodcastError("Missing GitHub settings for the podcast bucket: " + ", ".join(missing))
    s3 = client or _client()
    bucket = os.environ["R2_BUCKET"].strip()
    ep_id = uuid.uuid4().hex

    audio_key = f"podcast/audio/{ep_id}.mp3"
    s3.upload_file(str(mp3), bucket, audio_key, ExtraArgs={"ContentType": "audio/mpeg"})

    image_key = None
    if cover is not None:
        sq = square_cover(cover, work / f"{ep_id}-cover.jpg")
        image_key = f"podcast/images/{ep_id}.jpg"
        s3.upload_file(str(sq), bucket, image_key, ExtraArgs={"ContentType": "image/jpeg"})

    draft = {
        "id": ep_id,
        "guid": ep_id,
        "title": title.strip()[:200] or output_name,
        "description": description.strip(),
        "audio": audio_key,
        "bytes": mp3.stat().st_size,
        "duration": round(duration_of(mp3)),
        "image": image_key,
        "source": source,
        "output": output_name,
        "created": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "run": os.environ.get("GITHUB_RUN_ID", ""),
    }
    _replace_draft(s3, bucket, draft)
    return draft


def _replace_draft(s3, bucket: str, draft: dict) -> None:
    """Make this the next episode. The previous draft's files are deleted unless that
    episode was already published (then the feed still needs them)."""
    old = _get_json(s3, bucket, "podcast/draft.json")
    s3.put_object(Bucket=bucket, Key="podcast/draft.json", Body=json.dumps(draft, indent=2).encode(),
                  ContentType="application/json")
    if not old or old.get("id") == draft["id"]:
        return
    published = {e.get("id") for e in (_get_json(s3, bucket, "podcast/episodes.json") or [])}
    if old.get("id") in published:
        return
    for key in (old.get("audio"), old.get("image")):
        if key and key.startswith("podcast/") and key not in (draft.get("audio"), draft.get("image")):
            s3.delete_object(Bucket=bucket, Key=key)


def _get_json(s3, bucket: str, key: str):
    try:
        return json.loads(s3.get_object(Bucket=bucket, Key=key)["Body"].read())
    except Exception:   # noqa: BLE001 - missing or unreadable means "none"
        return None
