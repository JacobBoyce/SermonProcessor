// GET /api/video/:id: stream a video (or podcast MP3) from Drive to the page's players.
// Passes the browser's Range header through, so seeking only fetches the part needed.
import { AppError, drive } from "../../../lib/google.js";
import { wrap } from "../../../lib/http.js";

const PASS = ["content-type", "content-length", "content-range", "accept-ranges", "etag", "last-modified"];

export const onRequestGet = wrap(async ({ env, params, request }) => {
  const id = String(params.id || "");
  if (!/^[\w-]{10,}$/.test(id)) throw new AppError("Bad video id");
  const meta = await drive(env, `/files/${id}`, { fields: "mimeType,name" });
  const isMedia = /^(video|audio)\//.test(String(meta.mimeType)) || /\.(mp4|mov|m4v|mkv|mts|avi|mp3)$/i.test(meta.name || "");
  if (!isMedia) throw new AppError("Only video and audio can be played here");

  const range = request.headers.get("range");
  const r = await drive(env, `/files/${id}`, { alt: "media" }, true, range ? { Range: range } : {});
  if (!r.ok && r.status !== 206) throw new AppError(`Drive said ${r.status}`, 502);

  const headers = new Headers({ "cache-control": "private, max-age=600", "accept-ranges": "bytes" });
  for (const h of PASS) {
    const v = r.headers.get(h);
    if (v) headers.set(h, v);
  }
  if (!/^(video|audio)\//.test(String(headers.get("content-type")))) {
    headers.set("content-type", /^(video|audio)\//.test(meta.mimeType) ? meta.mimeType : /\.mp3$/i.test(meta.name || "") ? "audio/mpeg" : "video/mp4");
  }
  return new Response(r.body, { status: r.status, headers });
});
