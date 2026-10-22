"""Write a sermon description with Gemini from the rendered audio.

Makes a small audio-only copy of the output, uploads it to the Gemini Files API,
asks for a title and a short summary (as JSON), and builds a
plain-text description that is safe for YouTube (no < or >, under 5,000
characters) and usable for the podcast feed.

Needs GEMINI_API_KEY. GEMINI_MODEL picks the model (default below).
DESCRIPTION_EXAMPLE (optional) is a sample description whose style to follow.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import time
from pathlib import Path

import requests

BASE = "https://generativelanguage.googleapis.com"
DEFAULT_MODEL = "gemini-3.8-flash"
PROMPT_FILE = Path(__file__).resolve().parent.parent / "prompts" / "description.md"
YOUTUBE_LIMIT = 5000

# Gemini returns this shape. Edit prompts/description.md to change what goes in it.
SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "title": {"type": "STRING"},
        "summary": {"type": "STRING"},
    },
    "required": ["title", "summary"],
}


class DescribeError(Exception):
    pass


def small_audio(media: Path, dest: Path) -> Path:
    """Speech-quality mono MP3 (~14 MB per hour) to keep the upload quick."""
    subprocess.run(["ffmpeg", "-hide_banner", "-v", "error", "-y", "-i", str(media), "-vn",
                    "-ac", "1", "-ar", "16000", "-c:a", "libmp3lame", "-b:a", "32k", str(dest)], check=True)
    return dest


def _key() -> str:
    key = os.environ.get("GEMINI_API_KEY", "").strip()
    if not key:
        raise DescribeError("No GEMINI_API_KEY secret, so no description was written")
    return key


def upload(path: Path, key: str) -> dict:
    size = path.stat().st_size
    r = requests.post(f"{BASE}/upload/v1beta/files", timeout=60,
                      headers={"x-goog-api-key": key, "X-Goog-Upload-Protocol": "resumable",
                               "X-Goog-Upload-Command": "start", "X-Goog-Upload-Header-Content-Length": str(size),
                               "X-Goog-Upload-Header-Content-Type": "audio/mpeg"},
                      json={"file": {"display_name": path.name}})
    if r.status_code != 200 or "x-goog-upload-url" not in r.headers:
        raise DescribeError(f"Gemini upload didn't start ({r.status_code}): {r.text[:300]}")
    with path.open("rb") as fh:
        r = requests.post(r.headers["x-goog-upload-url"], data=fh, timeout=600,
                          headers={"Content-Length": str(size), "X-Goog-Upload-Offset": "0",
                                   "X-Goog-Upload-Command": "upload, finalize"})
    if r.status_code != 200:
        raise DescribeError(f"Gemini upload failed ({r.status_code}): {r.text[:300]}")
    info = r.json()["file"]
    # Audio is usually ready at once; wait while Gemini processes it if not.
    for _ in range(60):
        if info.get("state", "ACTIVE") == "ACTIVE":
            return info
        if info.get("state") == "FAILED":
            raise DescribeError("Gemini couldn't process the audio")
        time.sleep(5)
        info = requests.get(f"{BASE}/v1beta/{info['name']}", headers={"x-goog-api-key": key}, timeout=30).json()
    raise DescribeError("Gemini took too long to process the audio")


def delete(info: dict, key: str) -> None:
    try:
        requests.delete(f"{BASE}/v1beta/{info['name']}", headers={"x-goog-api-key": key}, timeout=30)
    except requests.RequestException:
        pass   # Gemini deletes uploads after 48 hours anyway


def build_prompt(notes: str) -> str:
    text = PROMPT_FILE.read_text()
    notes = notes.strip()
    example = os.environ.get("DESCRIPTION_EXAMPLE", "").strip()
    text = text.replace("{{notes}}", f"Notes from the church about this recording: {notes}" if notes else "")
    text = text.replace("{{example}}", f"Match the style of this past description:\n{example}" if example else "")
    return text.strip()


def ask(info: dict, prompt: str, key: str, model: str) -> dict:
    body = {
        "contents": [{"role": "user", "parts": [
            {"file_data": {"mime_type": info.get("mimeType", "audio/mpeg"), "file_uri": info["uri"]}},
            {"text": prompt}]}],
        "generationConfig": {"responseMimeType": "application/json", "responseSchema": SCHEMA, "temperature": 0.4},
    }
    last = ""
    for attempt in range(4):
        r = requests.post(f"{BASE}/v1beta/models/{model}:generateContent", json=body, timeout=600,
                          headers={"x-goog-api-key": key})
        if r.status_code in (429, 500, 502, 503, 504):
            last = r.text[:200]
            time.sleep(10 * (attempt + 1))
            continue
        if r.status_code != 200:
            raise DescribeError(f"Gemini said {r.status_code}: {r.text[:300]}")
        try:
            text = "".join(p.get("text", "") for p in r.json()["candidates"][0]["content"]["parts"])
        except (KeyError, IndexError):
            raise DescribeError(f"Gemini sent no text back: {r.text[:300]}") from None
        text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text.strip())
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            raise DescribeError(f"Gemini's answer wasn't valid JSON: {text[:200]}") from None
    raise DescribeError(f"Gemini was busy; try again later ({last})")


def clean(text: str) -> str:
    """YouTube rejects < and > in descriptions."""
    return str(text).replace("<", "‹").replace(">", "›").strip()


def compose(data: dict) -> str:
    parts = [clean(data.get("summary", ""))]
    scriptures = [clean(s) for s in data.get("scriptures") or [] if str(s).strip()]
    if scriptures:
        parts.append("Scripture: " + "; ".join(scriptures))
    chapters = [c for c in data.get("chapters") or [] if c.get("time") and c.get("title")]
    if len(chapters) >= 3:
        if chapters[0]["time"] not in ("0:00", "00:00", "0:00:00"):
            chapters[0]["time"] = "0:00"      # YouTube only shows chapters that start at 0:00
        parts.append("Chapters\n" + "\n".join(f"{clean(c['time'])} {clean(c['title'])}" for c in chapters))
    text = "\n\n".join(p for p in parts if p)
    return text[:YOUTUBE_LIMIT].rstrip()


def describe(media: Path, work: Path, notes: str = "") -> tuple[str, str, dict]:
    """Return (title, description text, raw JSON) for a rendered output."""
    key = _key()
    model = os.environ.get("GEMINI_MODEL", "").strip() or DEFAULT_MODEL
    audio = small_audio(media, work / "describe.mp3")
    print(f"  Sending {audio.stat().st_size / 1048576:.1f} MB of audio to {model}")
    info = upload(audio, key)
    try:
        data = ask(info, build_prompt(notes), key, model)
    finally:
        delete(info, key)
        audio.unlink(missing_ok=True)
    return clean(data.get("title", ""))[:100], compose(data), data
