# SermonProcessor

A project that takes a video from a drive and edits it then creates a YouTube video and Spotify post.

Right now (Phase 1) it cuts a recorded service into finished videos, with an optional end graphic and podcast MP3.

## Try it (Phase 1)

1. Open the **Actions** tab, pick **Render**, and click **Run workflow**.
2. Leave the defaults and click the green **Run workflow** button.
3. When the run finishes (a few minutes), open it and download **rendered-files** at the bottom.

The run makes a test clip with a color pattern and a tone that changes pitch every 30 seconds, then renders:

| File | What to check |
| --- | --- |
| `2026-10-18 YouTube.mp4` | Starts at 0:15 of the test clip. Fades into the end graphic over 1.5 s. The graphic holds 5 s in silence. |
| `2026-10-18 YouTube.mp3` | Same section as audio only: mono, 96 kbps, even loudness, short fades. |
| `2026-10-18 Baptism.mp4` | A second cut from the same source, with no graphic. |

Files land in `2026/Sample Series/`, the same year and series folders the real Drive will use.

### Your own times

Paste this into **outputs** when you run it, and change the numbers:

```json
[{"name":"YouTube","in":"0:20","out":"1:40","podcast":true,
  "endGraphic":{"file":"Graphics/end-card.png","seconds":5,"crossfade":1}},
 {"name":"Baptism","in":"1:50","out":"2:40","endGraphic":null}]
```

Times can be `m:ss`, `h:mm:ss` or plain seconds, with decimals (`41:27.5`). Set `crossfade` to `0` for a hard cut.

## How it works

- `worker/render.py` reads a job file and runs FFmpeg once per output (see the top of the file for the format).
- `worker/make_sample.py` makes the test clip, the end graphic and a sample job.
- `.github/workflows/render.yml` runs both on a GitHub machine.

Each output's length is `(out − in) + graphic seconds`. The crossfade overlaps the end of the clip, so the graphic always gets its full time on screen.
