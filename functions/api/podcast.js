// GET /api/podcast: show settings, drafts and published episodes.
// POST /api/podcast: { action: "publish" | "update" | "unpublish" | "delete" | "show", ... }
// Behind the same sign-in as the rest of /api (see _middleware.js).
import { AppError, drive } from "../../lib/google.js";
import { json, wrap } from "../../lib/http.js";
import { bucket, getDrafts, getEpisodes, getJson, getShow, putJson, SHOW_DEFAULTS } from "../../lib/podcast.js";

const ID = /^[0-9a-f]{32}$/;
const clean = (s, max) => String(s ?? "").replace(/\r\n/g, "\n").trim().slice(0, max);

// Width and height of a PNG or JPEG, to warn about covers that podcast apps reject.
function imageSize(buf) {
  const b = new Uint8Array(buf);
  if (b[0] === 0x89 && b[1] === 0x50) {
    const v = new DataView(buf);
    return { w: v.getUint32(16), h: v.getUint32(20) };
  }
  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i < b.length - 9) {
      if (b[i] !== 0xff) { i++; continue; }
      const marker = b[i + 1], len = (b[i + 2] << 8) | b[i + 3];
      if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xcf && marker !== 0xc8 && marker !== 0xcc)) {
        return { h: (b[i + 5] << 8) | b[i + 6], w: (b[i + 7] << 8) | b[i + 8] };
      }
      i += 2 + len;
    }
  }
  return null;
}

export const onRequestGet = wrap(async ({ env, request }) => {
  if (!env.PODCAST_BUCKET) return json({ configured: false });
  const [show, drafts, episodes] = await Promise.all([getShow(env), getDrafts(env), getEpisodes(env)]);
  const origin = new URL(request.url).origin;
  return json({ configured: true, feedUrl: `${origin}/podcast/feed.xml`, show, drafts, episodes });
});

export const onRequestPost = wrap(async ({ env, request, data }) => {
  const body = (await request.json().catch(() => null)) || {};
  const b = bucket(env);
  const who = data?.user?.email || "";

  if (body.action === "show") {
    const s = body.show || {};
    const show = { ...(await getShow(env)) };
    for (const k of ["title", "author", "email", "language", "category", "subcategory", "link"]) {
      if (k in s) show[k] = clean(s[k], 300);
    }
    if ("description" in s) show.description = clean(s.description, 4000);
    if ("explicit" in s) show.explicit = Boolean(s.explicit);
    if ("test" in s) show.test = Boolean(s.test);
    if (!show.title) throw new AppError("The show needs a title");
    let warning = "";
    if (s.coverId) {
      // Copy the chosen image from Drive's Graphics folder into the bucket, so the feed can serve it.
      const meta = await drive(env, `/files/${s.coverId}`, { fields: "mimeType,size,name" });
      if (!/^image\/(png|jpeg)$/.test(meta.mimeType)) throw new AppError("The show cover must be a PNG or JPG");
      const r = await drive(env, `/files/${s.coverId}`, { alt: "media" }, true);
      if (!r.ok) throw new AppError(`Drive said ${r.status}`, 502);
      const buf = await r.arrayBuffer();
      const size = imageSize(buf);
      if (size && (size.w !== size.h || size.w < 1400 || size.w > 3000)) {
        warning = `The cover is ${size.w}×${size.h}. Spotify and Apple want a square image between 1400×1400 and 3000×3000.`;
      }
      const ext = meta.mimeType === "image/png" ? "png" : "jpg";
      const key = `podcast/images/show-${Date.now().toString(36)}.${ext}`;
      await b.put(key, buf, { httpMetadata: { contentType: meta.mimeType } });
      if (show.image && show.image !== key) await b.delete(show.image);
      show.image = key;
    }
    await putJson(env, "podcast/show.json", show);
    return json({ ok: true, show, warning });
  }

  const id = String(body.id || "");
  if (!ID.test(id)) throw new AppError("Unknown episode");
  const episodes = await getEpisodes(env);

  if (body.action === "publish") {
    const draft = await getJson(env, `podcast/drafts/${id}.json`, null);
    if (!draft) throw new AppError("That draft is gone. Refresh the list.", 404);
    const title = clean(body.title ?? draft.title, 200);
    if (!title) throw new AppError("The episode needs a title");
    const ep = {
      ...draft,
      title,
      description: clean(body.description ?? draft.description, 4000),
      published: new Date().toISOString(),
      publishedBy: who,
    };
    await putJson(env, "podcast/episodes.json", [ep, ...episodes.filter((e) => e.id !== id)]);
    await b.delete(`podcast/drafts/${id}.json`);
    return json({ ok: true, episode: ep });
  }

  if (body.action === "update") {
    const i = episodes.findIndex((e) => e.id === id);
    if (i < 0) throw new AppError("That episode isn't in the feed", 404);
    if ("title" in body) episodes[i].title = clean(body.title, 200) || episodes[i].title;
    if ("description" in body) episodes[i].description = clean(body.description, 4000);
    await putJson(env, "podcast/episodes.json", episodes);
    return json({ ok: true, episode: episodes[i] });
  }

  if (body.action === "unpublish") {
    const ep = episodes.find((e) => e.id === id);
    if (!ep) throw new AppError("That episode isn't in the feed", 404);
    if (ep.imported) throw new AppError("Imported episodes from the old host can't be moved back to drafts");
    const { published, publishedBy, ...draft } = ep;
    await putJson(env, `podcast/drafts/${id}.json`, draft);
    await putJson(env, "podcast/episodes.json", episodes.filter((e) => e.id !== id));
    return json({ ok: true });
  }

  if (body.action === "delete") {
    if (episodes.some((e) => e.id === id)) throw new AppError("Take the episode out of the feed before deleting it");
    const draft = await getJson(env, `podcast/drafts/${id}.json`, null);
    if (!draft) throw new AppError("That draft is gone. Refresh the list.", 404);
    await b.delete([`podcast/drafts/${id}.json`, draft.audio, draft.image].filter(Boolean));
    return json({ ok: true });
  }

  throw new AppError("Unknown action");
});

export { SHOW_DEFAULTS };
