// GET /api/video/:id: stream a video from Drive to the preview player.
// Passes the browser's Range header through, so seeking only fetches the part needed.
import { AppError, drive } from "../../../lib/google.js";
import { wrap } from "../../../lib/http.js";

const PASS = ["content-type", "content-length", "content-range", "accept-ranges", "etag", "last-modified"];

export const onRequestGet = wrap(async ({ env, params, request }) => {
  const id = String(params.id || "");
  if (!/^[\w-]{10,}$/.test(id)) throw new AppError("Bad video id");
  const meta = await drive(env, `/files/${id}`, { fields: "mimeType,name" });
  const isVideo = String(meta.mimeType).startsWith("video/") || /\.(mp4|mov|m4v|mkv|mts|avi)$/i.test(meta.name || "");
  if (!isVideo) throw new AppError("Only videos can be streamed here");

  const range = request.headers.get("range");
  const r = await drive(env, `/files/${id}`, { alt: "media" }, true, range ? { Range: range } : {});
  if (!r.ok && r.status !== 206) throw new AppError(`Drive said ${r.status}`, 502);

  const headers = new Headers({ "cache-control": "private, max-age=600", "accept-ranges": "bytes" });
  for (const h of PASS) {
    const v = r.headers.get(h);
    if (v) headers.set(h, v);
  }
  if (!String(headers.get("content-type")).startsWith("video/")) headers.set("content-type", meta.mimeType.startsWith("video/") ? meta.mimeType : "video/mp4");
  return new Response(r.body, { status: r.status, headers });
});
