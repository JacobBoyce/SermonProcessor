#!/usr/bin/env python3
"""Run a job against Google Drive: download, render, upload.

Drive layout (inside the folder named by DRIVE_ROOT_FOLDER_ID). Any subfolders
work: year/month, year/series, or none.
    Incoming/2026/October/2026-10-18 service.mp4
    Incoming/2026/October/2026-10-18 service.txt        (optional: your own description)
    Thumbnails/2026/October/2026-10-18 service.png      (same name, .png/.jpg)
    Graphics/2026/Romans/end-card.png                   (or Graphics/end-card.png)
    Output/2026/October/...                             (created as needed)

Thumbnails and description files are looked for in the same subfolders as the
video first, then anywhere with the same name (if only one matches).

Usage:
    python worker/run_job.py list
    python worker/run_job.py render --job '{"source": "2026/Romans/2026-10-18 service.mp4", "outputs": [...]}'

In a render job, "source" is the path inside Incoming and each endGraphic "file"
is the path inside Graphics. The output folders copy the source's year/series
folders, and the date comes from the file name when it starts with YYYY-MM-DD.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import sys
import time
from pathlib import Path, PurePosixPath

sys.path.insert(0, str(Path(__file__).resolve().parent))
import render  # noqa: E402
from drive import Drive, DriveError  # noqa: E402
import describe  # noqa: E402
import podcast  # noqa: E402
import youtube  # noqa: E402

FOLDERS = ("Incoming", "Graphics", "Thumbnails", "Output")
VIDEO_EXT = {".mp4", ".mov", ".m4v", ".mkv", ".mts", ".avi"}
IMAGE_EXT = (".png", ".jpg", ".jpeg")
DATE_RE = re.compile(r"^(\d{4}-\d{2}-\d{2})")


def folder_id_from(value: str) -> str:
    """Accept a bare folder ID or a whole Drive link, and return just the ID."""
    value = value.strip()
    if "/folders/" in value:
        value = value.split("/folders/", 1)[1]
    return re.split(r"[?&#/\s]", value, maxsplit=1)[0]


def summary(text: str) -> None:
    """Add a line to the GitHub run page summary, when running in Actions."""
    path = os.environ.get("GITHUB_STEP_SUMMARY")
    if path:
        with open(path, "a") as fh:
            fh.write(text + "\n")


def top_folders(drive, root_id: str) -> dict:
    root = drive.get(root_id)
    found = {}
    for name in FOLDERS:
        f = drive.child(root_id, name, folder=True)
        if f is None:
            raise DriveError(f"Make a folder named '{name}' inside '{root.name}'")
        found[name] = f
    return found


def find_matching(drive, folder_id: str, rel_video: str, exts: tuple[str, ...]):
    """A file named like the video (e.g. .png for a thumbnail, .txt for a description).

    First the same subfolders as the video; if the folders don't line up, any file
    with that name anywhere under the folder, as long as only one matches.
    """
    p = PurePosixPath(rel_video)
    folder = folder_id
    same_path = True
    for part in p.parent.parts:
        f = drive.child(folder, part, folder=True)
        if f is None:
            same_path = False
            break
        folder = f.id
    if same_path:
        for ext in exts:
            f = drive.child(folder, p.stem + ext, folder=False)
            if f:
                return f
    hits = [f for path, f in drive.walk(folder_id)
            if PurePosixPath(path).stem.lower() == p.stem.lower() and PurePosixPath(path).suffix.lower() in exts]
    return hits[0] if len(hits) == 1 else None


def find_thumbnail(drive, thumbs_id: str, rel_video: str):
    return find_matching(drive, thumbs_id, rel_video, IMAGE_EXT)


class Progress:
    """Overall progress for the web app, saved as private labels on the source video.

    Stages and their share of the bar: download 5%, render 78%, upload 5%,
    description 3%, YouTube 9%. Saved at most every 15 s (and on each stage change). Any
    problem saving progress is ignored: it must never stop a render.
    """
    STAGES = {"download": (0.00, 0.05), "render": (0.05, 0.78), "upload": (0.83, 0.05), "describe": (0.88, 0.03),
              "youtube": (0.91, 0.09)}
    EVERY = 15.0

    def __init__(self, drive, file_id: str):
        self.drive, self.file_id = drive, file_id
        self.run = os.environ.get("GITHUB_RUN_ID", "local")
        self.last_write, self.last_stage = 0.0, ""
        self.stage_started = time.monotonic()
        self.stage_rate_bytes = 0.0

    def update(self, stage: str, frac: float, label: str, eta: float | None = None, force: bool = False) -> None:
        now = time.monotonic()
        if stage != self.last_stage:
            self.last_stage, self.stage_started, force = stage, now, True
        if not force and now - self.last_write < self.EVERY:
            return
        start, share = self.STAGES.get(stage, (1.0, 0.0))
        pct = min(100.0, 100 * (start + share * max(0.0, min(frac, 1.0))))
        self._save({"sp_run": self.run, "sp_stage": label, "sp_pct": f"{pct:.0f}",
                    "sp_eta": "" if eta is None else f"{max(eta, 0):.0f}", "sp_at": f"{time.time():.0f}"})
        self.last_write = now

    def render(self, label: str, frac: float) -> None:
        elapsed = time.monotonic() - self.stage_started
        # Remaining render time from the speed so far, plus ~3 min for uploads and the description.
        eta = elapsed / frac * (1 - frac) + 180 if frac > 0.02 else None
        self.update("render", frac, f"Rendering {label}", eta)

    def finish(self, ok: bool, note: str = "") -> None:
        self._save({"sp_run": self.run, "sp_stage": note or ("Done" if ok else "Failed"),
                    "sp_pct": "100" if ok else "", "sp_eta": "0" if ok else "", "sp_at": f"{time.time():.0f}"})

    def _save(self, props: dict) -> None:
        try:
            self.drive.set_properties(self.file_id, props)
        except Exception as exc:   # noqa: BLE001 - progress is best-effort
            print(f"    (couldn't save progress: {exc})")


def mb(n: int) -> str:
    return f"{n / 1048576:,.0f} MB" if n < 1 << 30 else f"{n / (1 << 30):,.1f} GB"


# ---------------------------------------------------------------- actions

def do_list(drive, root_id: str) -> None:
    folders = top_folders(drive, root_id)
    summary("## Drive check\n")
    incoming = [(path, f) for path, f in drive.walk(folders["Incoming"].id)]
    videos = [(p, f) for p, f in incoming if PurePosixPath(p).suffix.lower() in VIDEO_EXT]
    print(f"Incoming: {len(videos)} video(s)")
    summary("| Video | Size | Thumbnail |\n| --- | --- | --- |")
    for path, f in videos:
        thumb = find_thumbnail(drive, folders["Thumbnails"].id, path)
        mark = thumb.name if thumb else "missing"
        print(f"  {path}  ({mb(f.size)})  thumbnail: {mark}")
        summary(f"| {path} | {mb(f.size)} | {mark} |")
    for name in ("Graphics", "Thumbnails", "Output"):
        items = list(drive.walk(folders[name].id))
        print(f"{name}: {len(items)} file(s)")
        for path, f in items[:50]:
            print(f"  {path}  ({mb(f.size)})")
        summary(f"\n**{name}:** {len(items)} file(s)")


def do_render(drive, root_id: str, job: dict, work: Path, height: str | None) -> None:
    folders = top_folders(drive, root_id)
    rel_source = str(job.get("source") or "").strip("/")
    if not rel_source:
        raise render.JobError("The job needs a 'source': the video's path inside Incoming")
    src = drive.resolve(folders["Incoming"].id, rel_source)

    free = shutil.disk_usage(work).free
    print(f"Source: Incoming/{rel_source} ({mb(src.size)}); free disk {mb(free)}")
    if src.size and src.size * 2.2 > free:
        print("  Warning: disk space is tight for this source and its renders.")

    prog = Progress(drive, src.id)
    prog.update("download", 0, "Downloading the video", force=True)
    try:
        written, out_dir, local_job = _process(drive, folders, rel_source, src, job, work, height, prog)
        prog.update("describe", 0, "Writing the description", 60, force=True)
        described = write_description(drive, folders, rel_source, local_job, written, out_dir, work)
        prog.update("describe", 0.8, "Saving the podcast draft", 30, force=True)
        save_podcast_drafts(drive, folders, rel_source, local_job, written, described, work)
        upload_to_youtube(drive, folders, rel_source, local_job, written, described, work, prog)
    except BaseException:
        prog.finish(False)
        raise
    prog.finish(True)


def _process(drive, folders: dict, rel_source: str, src, job: dict, work: Path, height: str | None, prog):
    """Download, render and upload. Returns (written files, output folder, local job)."""
    t0 = time.monotonic()

    def dl(done, total):
        rate = done / max(time.monotonic() - t0, 0.1)
        prog.update("download", done / total if total else 0,
                    f"Downloading the video ({done * 100 // max(total, 1)}%)",
                    (total - done) / rate if rate and total else None)

    local_src = drive.download(src, work / "source" / src.name, on_bytes=dl)

    local_job = dict(job)
    local_job["source"] = str(local_src)
    p = PurePosixPath(rel_source)
    local_job.setdefault("folder", str(p.parent) if str(p.parent) != "." else "")
    m = DATE_RE.match(p.stem)
    if m and not local_job.get("date"):
        local_job["date"] = m.group(1)
    if not local_job.get("date") and not local_job.get("prefix"):
        local_job["prefix"] = PurePosixPath(src.name).stem   # no date in the name: use the file name
    if height:
        local_job.setdefault("video", {})["height"] = height

    graphics: dict[str, str] = {}
    for out in local_job.get("outputs", []):
        g = out.get("endGraphic")
        if not g:
            continue
        name = str(g.get("file") or "")
        if not name:
            images = [path for path, f in drive.walk(folders["Graphics"].id) if path.lower().endswith(IMAGE_EXT)]
            if len(images) != 1:
                raise render.JobError("Say which end graphic to use (\"file\"): "
                                      + (", ".join(images) or "the Graphics folder is empty"))
            name = images[0]
        if name not in graphics:
            gf = drive.resolve(folders["Graphics"].id, name)
            local = work / "graphics" / str(len(graphics)) / gf.name     # same names in different folders can't clash
            graphics[name] = str(drive.download(gf, local, progress=lambda *_: None))
        g["file"] = graphics[name]

    thumb = find_thumbnail(drive, folders["Thumbnails"].id, rel_source)
    print(f"Thumbnail: {thumb.name if thumb else 'none found (add one to Thumbnails with the same name)'}")

    job_path = work / "job.json"
    job_path.write_text(json.dumps(local_job, indent=2))
    out_dir = work / "output"
    written = render.render(job_path, out_dir, on_progress=prog.render)

    local_src.unlink(missing_ok=True)   # free disk before uploading
    summary(f"## Rendered `{rel_source}`\n\n| File | Size | Drive |\n| --- | --- | --- |")
    print("\nUploading to Output:")
    total_up = sum(f.stat().st_size for f in written) or 1
    sent_before, t_up = 0, time.monotonic()
    for f in written:
        def up(done, _total, base=sent_before, name=f.name):
            now_sent = base + done
            rate = now_sent / max(time.monotonic() - t_up, 0.1)
            prog.update("upload", now_sent / total_up, f"Uploading {name}", (total_up - now_sent) / rate + 60 if rate else None)
        rel_dir = f.parent.relative_to(out_dir).as_posix()
        folder_id = drive.ensure_folder(folders["Output"].id, "" if rel_dir == "." else rel_dir)
        file_id = drive.upload(f, folder_id, on_bytes=up)
        sent_before += f.stat().st_size
        where = f"Output/{rel_dir}/{f.name}" if rel_dir != "." else f"Output/{f.name}"
        print(f"  {where}")
        summary(f"| {where} | {mb(f.stat().st_size)} | [open](https://drive.google.com/file/d/{file_id}/view) |")
    return written, out_dir, local_job


def write_description(drive, folders: dict, rel_source: str, job: dict, written: list[Path],
                      out_dir: Path, work: Path) -> tuple[str, str] | None:
    """Save '<name> description.txt' (and .json) next to the outputs.

    Uses the person's own .txt from Incoming when there is one; otherwise asks
    Gemini. Problems here are reported but never fail the job: the videos are
    already in Drive by now.
    """
    opts = job.get("describe", True)
    if isinstance(opts, bool):
        opts = {"enabled": opts}
    if not opts.get("enabled", True) or not written:
        return None
    main = next((f for f in written if f.suffix == ".mp3"), written[0])   # podcast audio, else first video
    label = str(job.get("prefix") or job.get("date") or "").strip()
    base = f"{label} description" if label else "description"
    rel_dir = main.parent.relative_to(out_dir).as_posix()
    folder_id = drive.ensure_folder(folders["Output"].id, "" if rel_dir == "." else rel_dir)
    print("\nDescription:")
    try:
        own = find_matching(drive, folders["Incoming"].id, rel_source, (".txt",))
        if own:
            local = drive.download(own, work / "own-description.txt", progress=lambda *_: None)
            text = local.read_text(errors="replace").strip()
            title, body, data, source = str(job.get("title") or label), describe.clean(text)[:describe.YOUTUBE_LIMIT], None, own.name
        else:
            title, body, data = describe.describe(main, work, str(opts.get("notes") or ""),
                                                  str(opts.get("instructions") or ""))
            source = os.environ.get("GEMINI_MODEL", "").strip() or describe.DEFAULT_MODEL
        txt = main.parent / f"{base}.txt"
        txt.write_text(f"{title}\n\n{body}\n" if title else f"{body}\n")
        drive.upload(txt, folder_id, progress=lambda *_: None)
        record = {"title": title, "description": body, "source": source, "gemini": data}
        js = main.parent / f"{base}.json"
        js.write_text(json.dumps(record, indent=2, ensure_ascii=False))
        drive.upload(js, folder_id, progress=lambda *_: None)
        where = f"Output/{rel_dir}/{txt.name}" if rel_dir != "." else f"Output/{txt.name}"
        print(f"  from {source} → {where}\n\n{title}\n\n{body}")
        summary(f"\n## Description ({'your file ' + source if own else source})\n\n**{title}**\n\n" +
                body.replace("\n", "  \n"))
        return title, body
    except Exception as exc:   # noqa: BLE001 - a description problem must never fail a finished render
        print(f"  Skipped: {exc}")
        summary(f"\n**Description skipped:** {exc}")
        return None


def save_podcast_drafts(drive, folders: dict, rel_source: str, job: dict, written: list[Path],
                        described: tuple[str, str] | None, work: Path) -> None:
    """For each output marked "feed", save its podcast MP3 as a draft episode for the web app.

    Like the description, a problem here is reported but never fails the job.
    """
    # One next episode at a time: the first output marked for the feed.
    wanted = [o for o in job.get("outputs", []) if o.get("feed") and o.get("podcast")][:1]
    if not wanted:
        return
    print("\nPodcast drafts:")
    label = str(job.get("prefix") or job.get("date") or "").strip()
    prefix = f"{label} " if label else ""
    try:
        thumb = find_thumbnail(drive, folders["Thumbnails"].id, rel_source)
        cover = drive.download(thumb, work / "thumb" / thumb.name, progress=lambda *_: None) if thumb else None
        title, body = described or ("", "")
        for out in wanted:
            name = render.safe_name(str(out.get("name") or ""))
            mp3 = next((f for f in written if f.suffix == ".mp3" and f.name == f"{prefix}{name}.mp3"), None)
            if mp3 is None:
                print(f"  {name}: no podcast MP3 was made, so no draft")
                continue
            draft = podcast.save_draft(mp3, cover, title or f"{prefix}{name}".strip(), body, rel_source, name, work)
            print(f"  {name}: draft saved ({draft['duration'] // 60} min, {draft['bytes'] / 1048576:.0f} MB)"
                  f"{'' if cover else ', no thumbnail found so the show cover will be used'}")
            summary(f"\n**Podcast next episode ready:** {draft['title']}. Review and publish it in the web app's Podcast section.")
    except Exception as exc:   # noqa: BLE001
        print(f"  Skipped: {exc}")
        summary(f"\n**Podcast draft skipped:** {exc}")


def upload_to_youtube(drive, folders: dict, rel_source: str, job: dict, written: list[Path],
                      described: tuple[str, str] | None, work: Path, prog) -> None:
    """Upload each output marked "youtube" as a private video, with the description and thumbnail.

    Nothing is published: the video stays private until someone makes it public in
    YouTube Studio. A problem here is reported but never fails the job.
    """
    wanted = [o for o in job.get("outputs", []) if o.get("youtube")]
    if not wanted:
        return
    print("\nYouTube (private):")
    missing = youtube.missing_settings()
    if missing:
        print("  Skipped: missing GitHub secrets " + ", ".join(missing))
        summary("\n**YouTube upload skipped:** missing GitHub secrets " + ", ".join(missing))
        return
    label = str(job.get("prefix") or job.get("date") or "").strip()
    prefix = f"{label} " if label else ""
    title, body = described or ("", "")
    try:
        token = youtube._access_token()
        thumb = find_thumbnail(drive, folders["Thumbnails"].id, rel_source)
        jpg = None
        if thumb:
            local = drive.download(thumb, work / "yt-thumb" / thumb.name, progress=lambda *_: None)
            jpg = youtube.thumbnail_jpeg(local, work / "yt-thumb" / "thumbnail.jpg")
    except Exception as exc:   # noqa: BLE001
        print(f"  Skipped: {exc}")
        summary(f"\n**YouTube upload skipped:** {exc}")
        return
    total = sum(f.stat().st_size for o in wanted for f in written
                if f.suffix == ".mp4" and f.name == f"{prefix}{render.safe_name(str(o.get('name') or ''))}.mp4") or 1
    done = 0
    for out in wanted:
        name = render.safe_name(str(out.get("name") or ""))
        video = next((f for f in written if f.suffix == ".mp4" and f.name == f"{prefix}{name}.mp4"), None)
        if video is None:
            print(f"  {name}: no video was made, so nothing to upload")
            continue
        video_title = title or f"{prefix}{name}".strip()
        if title and len(wanted) > 1:
            video_title = f"{title} ({name})"
        try:
            base = done
            vid = youtube.upload(video, video_title, body, token=token,
                                 on_bytes=lambda s, _n, b=base: prog.update("youtube", (b + s) / total,
                                                                            "Uploading to YouTube" + (f" ({name})" if len(wanted) > 1 else "")))
            done += video.stat().st_size
            note = ""
            if jpg:
                try:
                    youtube.set_thumbnail(vid, jpg)
                except Exception as exc:   # noqa: BLE001
                    note = f" (thumbnail not set: {exc})"
            else:
                note = " (no thumbnail found in Thumbnails)"
            link = youtube.studio_link(vid)
            print(f"  {name}: uploaded as private → {link}{note}")
            summary(f"\n**On YouTube (private):** [{video_title}]({link}){note}")
        except Exception as exc:   # noqa: BLE001
            print(f"  {name}: upload failed: {exc}")
            summary(f"\n**YouTube upload failed for {name}:** {exc}")


def main() -> int:
    parser = argparse.ArgumentParser(description="Process a sermon video from Google Drive.")
    parser.add_argument("action", choices=["list", "render"])
    parser.add_argument("--job", default="", help="job JSON text, or a path to a job file")
    parser.add_argument("--height", default="", help="override output height: source or 1080")
    parser.add_argument("--work", type=Path, default=Path("work"))
    args = parser.parse_args()

    root_id = folder_id_from(os.environ.get("DRIVE_ROOT_FOLDER_ID", ""))
    try:
        if not root_id:
            raise DriveError("Set the DRIVE_ROOT_FOLDER_ID variable to your Sermon Cutter folder's ID")
        drive = Drive.from_env()
        if args.action == "list":
            do_list(drive, root_id)
        else:
            text = args.job.strip()
            if not text:
                raise render.JobError("Paste a job into the 'job' box")
            job = json.loads(Path(text).read_text()) if text.endswith(".json") and Path(text).is_file() \
                else json.loads(text)
            args.work.mkdir(parents=True, exist_ok=True)
            do_render(drive, root_id, job, args.work, args.height or None)
    except json.JSONDecodeError as exc:
        print(f"\nThe job isn't valid JSON: {exc}", file=sys.stderr)
        return 2
    except (DriveError, render.JobError) as exc:
        print(f"\nProblem: {exc}", file=sys.stderr)
        summary(f"\n**Problem:** {exc}")
        return 2
    except RuntimeError as exc:
        print(f"\n{exc}", file=sys.stderr)
        return 1
    print("\nDone.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
