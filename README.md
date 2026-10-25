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

## Run it on your Drive (Phase 2)

Needs the GitHub secrets `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN` and the variable `DRIVE_ROOT_FOLDER_ID` (see the setup steps in the build plan).

The Drive folder looks like this. Subfolders can be anything (year/month, year/series) at any depth:

```
Sermon Cutter/
  Incoming/2026/October/2026-10-18 service.mp4
  Incoming/2026/October/2026-10-18 service.txt   (optional: your own description; Gemini is skipped)
  Thumbnails/2026/October/2026-10-18 service.png (same name, .png or .jpg)
  Graphics/2026/Romans/romans-card.png           (or Graphics/Generic/..., or top level)
  Output/                                         (filled in by the worker, same subfolders)
```

Thumbnails and description files are matched in the same subfolders as the video first, then by name anywhere if only one file has that name.

1. **Check Drive:** Actions → **Process from Drive** → Run workflow with action **list**. The run page lists every video, whether its thumbnail was found, and the graphics.
2. **Render:** run it again with action **render** and a job like this:

```json
{"source": "2026/Romans/2026-10-18 service.mp4",
 "outputs": [
   {"name": "YouTube", "in": "2:45", "out": "41:27", "podcast": true,
    "endGraphic": {"file": "end-card.png", "seconds": 5, "crossfade": 1}},
   {"name": "Baptism", "in": "45:03", "out": "55:54", "endGraphic": null}]}
```

To skip a section in the middle of an output, give it `segments` instead of `in`/`out`. The parts are joined with a clean cut:

```json
{"name": "YouTube", "segments": [{"in": "2:45", "out": "20:10"}, {"in": "23:40", "out": "41:27"}]}
```

`source` is the path inside Incoming, and `file` is the path inside Graphics. Finished files go to `Output/2026/Romans/`, named with the date from the start of the video's file name. Running the same job again replaces those files instead of making copies. The run page links to each file in Drive.

## Web app (Phases 3–4)

`web/app/index.html` is the app (at `/app/`) and `functions/api/` is its API. The public pages Google requires for verifying the sign-in app are `web/index.html` (home, `/`), `web/pp.html` (privacy policy, `/pp`) and `web/terms.html` (`/terms`); Cloudflare Access should cover only the paths `app` and `api`, so these stay public, both hosted on Cloudflare Pages (free). The API reads Drive with the same Google sign-in as the worker, and starts **Process from Drive** on GitHub.

Cloudflare Pages settings: build command `sh scripts/stamp.sh` (stamps the commit into the page's bottom-right corner), build output directory `web`. Settings → Variables and secrets:

| Name | Type | Value |
| --- | --- | --- |
| `APP_PASSCODE` | Secret | The code people type to open the app |
| `GITHUB_TOKEN` | Secret | Fine-grained token for this repo with **Actions: Read and write** |
| `GITHUB_REPO` | Text | `JacobBoyce/SermonProcessor` |
| `GOOGLE_CLIENT_ID` | Secret | Same as the GitHub secret |
| `GOOGLE_CLIENT_SECRET` | Secret | Same as the GitHub secret |
| `GOOGLE_REFRESH_TOKEN` | Secret | Same as the GitHub secret |
| `DRIVE_ROOT_FOLDER_ID` | Text | Same as the GitHub variable |
| `ACCESS_TEAM_DOMAIN` | Text | Optional, for Cloudflare Access: e.g. `sermonprocessor.cloudflareaccess.com` |
| `ACCESS_AUD` | Text | Optional, for Cloudflare Access: the application's Audience (AUD) tag |

With Cloudflare Access set up, every API request's sign-in token is checked against those two settings (`lib/access.js`), and the page shows who's signed in. `APP_PASSCODE` can then be removed to drop the passcode screen; with both set, both are required.

### Hosting as a Cloudflare Worker

Cloudflare may set the project up as a **Worker** instead of Pages. That works too: rename `wrangler.worker.jsonc` to `wrangler.jsonc` (it's renamed so Pages doesn't warn about it), and `src/worker.js` serves the same page and API. The Worker's name in Cloudflare must be `sermon-processor` (or change `name` in that file to match). Add the settings above under the Worker's **Settings → Variables and Secrets**; `keep_vars` stops deploys from removing them. Every push to `main` redeploys.

## Descriptions (Phase 5)

After rendering, the worker sends a small audio-only copy of the main output (the podcast output if there is one) to Gemini and saves `<date> description.txt` and `.json` next to the videos in Output: a title and a summary of 5 sentences or less about the series and what this sermon teaches. A `.txt` with the video's name in Incoming is used instead, without calling Gemini. A description problem never fails the render.

GitHub settings: secret `GEMINI_API_KEY` (required), variables `GEMINI_MODEL` (optional, default `gemini-3.8-flash`) and `DESCRIPTION_EXAMPLE` (optional: a past description whose style to copy). The church's default instructions for Gemini are in `prompts/instructions.txt`: edit that file on GitHub to change the default (the web app shows it greyed out after the next deploy). Ticking **Use custom instructions** in the web app replaces them for one sermon. `prompts/description.md` wraps them with the fixed parts (output format, notes).

## Podcast feed (Phase 6)

The **Podcast** section has one **Next episode**: audio, image, title and description, then **Publish to the feed**. Tick **Add it to the podcast feed as a draft** on one output (with its podcast MP3 on) and, after the render, the worker fills the Next episode with the MP3, a square cover made from the video's thumbnail, and the description, replacing whatever was there. Or pick an MP3 (from Output or Incoming) and an image (Thumbnails or Graphics) from Drive and type the text; publishing copies them into the bucket. Taking an episode out of the feed deletes its audio.

- Public feed: `/podcast/feed.xml`; episode files: `/podcast/media/...` (both served from the bucket through the site's `PODCAST_BUCKET` binding). Everything else stays behind sign-in.
- Show settings (name, description, author, owner email, cover, test flag) are edited in the Podcast section and stored in the bucket. A test feed carries `itunes:block` so directories don't list it.
- GitHub settings for the worker: secrets `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`; variables `R2_ENDPOINT`, `R2_BUCKET`.
- With Cloudflare Access on, `/podcast/` needs its own Access application with a **Bypass** policy, so podcast apps can read it.

## YouTube, private upload (Phase 7)

Tick **Upload to YouTube as a private video** on an output and, after the render, the worker uploads that MP4 to YouTube as **private**, with the description's title and summary and the video's thumbnail from Thumbnails (made into a 1280×720 JPEG under 2 MB). Nothing is published: someone opens the video in YouTube Studio (the link is in the run's summary on GitHub), checks it and makes it public. A YouTube problem never fails the render; the video is already in Drive.

- GitHub settings: secret `YOUTUBE_REFRESH_TOKEN` (made with the same Google OAuth client as Drive, signed in as the account that owns the channel, scope `https://www.googleapis.com/auth/youtube.upload`); optional variable `YOUTUBE_CATEGORY` (default `29`, Nonprofits & Activism).
- The YouTube Data API v3 must be enabled in the Google Cloud project, and `youtube.upload` added to the OAuth consent screen's scopes.
- Custom thumbnails need a verified channel (youtube.com/verify). Without it the upload still works and YouTube picks a frame.
- Daily limit: the API allows about 100 uploads a day per Google project.
- **Who reads the feed:** the feed and audio addresses note which app made each request (from its user agent) in tiny objects under `podcast/stats/` in the bucket (`lib/stats.js`). The Episodes list shows which apps last checked the feed, and per episode whether Spotify copied it, whether Apple fetched it, and roughly how many downloads it had. Requests from the app's own players aren't counted. Counts are approximate.

## Without a render: AI descriptions and single YouTube uploads (Phase 8)

- **Write title and description with AI** (in the Podcast episode form and in the YouTube section) starts a short `describe` run on GitHub for the picked file: a Drive MP3 or video, or the rendered next episode's audio in the bucket. The worker writes the result to `ai/<request>.json` in the podcast bucket and the page fills in the fields when it appears (`GET /api/describe?id=`). Usually 2–4 minutes; the page picks it up again after a reload.
- **YouTube upload, no editing** picks a video from Output or Incoming, a thumbnail (matched by name or date, or chosen), a title and description, and starts a `youtube` run that uploads it as private.
- These runs don't wait behind a render: only renders share the one-at-a-time queue.
- Job JSON: `describe` = `{"request": "<32 hex>", "media": {"driveId": "…"} | {"r2": "podcast/audio/<id>.mp3"}, "name": "…"}`; `youtube` = `{"video": "<Drive id>", "title": "…", "description": "…", "thumbnail": "<Drive id>" | null}`.
