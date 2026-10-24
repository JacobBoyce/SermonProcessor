// GET /podcast/media/audio/<id>.mp3 and /podcast/media/images/<id>.jpg: public episode files.
// Supports Range requests, which podcast apps use to seek and resume downloads.

const ALLOWED = /^(audio\/[0-9a-f]{32}\.mp3|images\/([0-9a-f]{32}|show-[0-9a-z]+)\.jpe?g|images\/show-[0-9a-z]+\.png)$/;

function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header || "");
  if (!m) return null;
  let start = m[1] === "" ? null : Number(m[1]);
  let end = m[2] === "" ? null : Number(m[2]);
  if (start === null && end === null) return null;
  if (start === null) { start = Math.max(0, size - end); end = size - 1; }       // "bytes=-500": last 500 bytes
  if (end === null || end >= size) end = size - 1;
  if (start > end || start >= size) return "invalid";
  return { start, end };
}

export async function onRequest({ env, request, params }) {
  if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405 });
  if (!env.PODCAST_BUCKET) return new Response("Podcast not set up", { status: 503 });
  const rel = [].concat(params.path || []).join("/");
  if (!ALLOWED.test(rel)) return new Response("Not found", { status: 404 });
  const key = `podcast/${rel}`;

  const head = await env.PODCAST_BUCKET.head(key);
  if (!head) return new Response("Not found", { status: 404 });
  const size = head.size;
  const type = head.httpMetadata?.contentType || (rel.endsWith(".mp3") ? "audio/mpeg" : "image/jpeg");
  const base = { "content-type": type, "accept-ranges": "bytes", etag: head.httpEtag, "cache-control": "public, max-age=86400" };

  const range = parseRange(request.headers.get("range"), size);
  if (range === "invalid") return new Response(null, { status: 416, headers: { "content-range": `bytes */${size}` } });
  if (request.method === "HEAD") {
    return new Response(null, { headers: { ...base, "content-length": String(size) } });
  }
  if (range) {
    const obj = await env.PODCAST_BUCKET.get(key, { range: { offset: range.start, length: range.end - range.start + 1 } });
    return new Response(obj.body, {
      status: 206,
      headers: { ...base, "content-length": String(range.end - range.start + 1), "content-range": `bytes ${range.start}-${range.end}/${size}` },
    });
  }
  const obj = await env.PODCAST_BUCKET.get(key);
  return new Response(obj.body, { headers: { ...base, "content-length": String(size) } });
}
