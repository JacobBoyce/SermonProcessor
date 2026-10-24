// GET /api/podcast: show settings, the next episode (draft) and the episodes in the feed.
// POST /api/podcast: { action: "publish" | "clear" | "remove" | "update" | "show", ... }
// Behind the same sign-in as the rest of /api (see _middleware.js).
import { AppError, drive } from "../../lib/google.js";
import { json, wrap } from "../../lib/http.js";
import { bucket, copyFromDrive, getDraft, getEpisodes, getShow, putJson } from "../../lib/podcast.js";
import { dropEpisodeStats, readStats } from "../../lib/stats.js";

const ID = /^[0-9a-f]{32}$/;
const DRIVE_ID = /^[\w-]{10,}$/;
const AUDIO = /^audio\/(mpeg|mp3)$|\.mp3$/i;      // podcast apps expect MP3 here
const IMAGE = /^image\/(png|jpeg)$|\.(png|jpe?g)$/i;
const clean = (s, max) => String(s ?? "").replace(/\r\n/g, "\n").trim().slice(0, max);
const newId = () => [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");

// Width and height of a PNG or JPEG, to warn about images podcast apps won't use.
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
      const m = b[i + 1], len = (b[i + 2] << 8) | b[i + 3];
      if ((m >= 0xc0 && m <= 0xc3) || (m >= 0xc5 && m <= 0xcf && m !== 0xc8 && m !== 0xcc)) {
        return { h: (b[i + 5] << 8) | b[i + 6], w: (b[i + 7] << 8) | b[i + 8] };
      }
      i += 2 + len;
    }
  }
  return null;
}

async function imageWarning(env, key, what) {
  const obj = await bucket(env).get(key, { range: { offset: 0, length: 65536 } });
  const size = obj ? imageSize(await new Response(obj.body).arrayBuffer()) : null;
  if (!size) return "";
  if (size.w !== size.h) {
    return what === "The show cover"
      ? `The show cover is ${size.w}×${size.h}, not square. Spotify and Apple require a square cover, so pick a square image before launch.`
      : `${what} is ${size.w}×${size.h}, not square, so podcast apps may show the show cover instead.`;
  }
  if (size.w < 1400 || size.w > 3000) return `${what} is ${size.w}×${size.w}. Spotify and Apple want 1400 to 3000 pixels square.`;
  return "";
}

// Delete files that nothing in the feed or the draft points to any more.
async function dropUnused(env, keys, keep) {
  const used = new Set(keep.flatMap((e) => [e?.audio, e?.image]).filter(Boolean));
  const gone = keys.filter((k) => k && k.startsWith("podcast/") && !used.has(k));
  if (gone.length) await bucket(env).delete(gone);
}

export const onRequestGet = wrap(async ({ env, request }) => {
  if (!env.PODCAST_BUCKET) return json({ configured: false });
  const [show, draft, episodes, stats] = await Promise.all([getShow(env), getDraft(env), getEpisodes(env),
    readStats(env).catch(() => ({ feed: [], episodes: {} }))]);
  const origin = new URL(request.url).origin;
  return json({ configured: true, feedUrl: `${origin}/podcast/feed.xml`, show, draft, episodes, stats });
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
    if (!show.title) throw new AppError("The show needs a name");
    let warning = "";
    if (s.coverId) {
      if (!DRIVE_ID.test(s.coverId)) throw new AppError("Bad cover");
      const key = `podcast/images/show-${Date.now().toString(36)}.jpg`;
      await copyFromDrive(env, drive, s.coverId, key, IMAGE);
      warning = await imageWarning(env, key, "The show cover");
      if (show.image && show.image !== key) await b.delete(show.image);
      show.image = key;
    }
    await putJson(env, "podcast/show.json", show);
    return json({ ok: true, show, warning });
  }

  const episodes = await getEpisodes(env);
  const draft = await getDraft(env);

  if (body.action === "publish") {
    // Audio and image come from the next-episode draft (a render) or are picked from Drive.
    const title = clean(body.title, 200);
    if (!title) throw new AppError("The episode needs a title");
    const description = clean(body.description, 4000);
    const id = draft && body.audio === "draft" ? draft.id : newId();
    let audio, bytes, duration;
    if (body.audio === "draft") {
      if (!draft) throw new AppError("There's no rendered audio waiting. Pick an MP3 from Drive or render one.");
      ({ audio, bytes, duration } = draft);
    } else if (body.audio && DRIVE_ID.test(String(body.audio.driveId || ""))) {
      audio = `podcast/audio/${id}.mp3`;
      const c = await copyFromDrive(env, drive, body.audio.driveId, audio, AUDIO);
      bytes = c.size;
      duration = Math.round(Number(body.audio.duration) || 0);
    } else {
      throw new AppError("Pick the episode's audio");
    }
    let image = null, warning = "";
    if (body.image === "draft") {
      image = draft?.image || null;
    } else if (body.image && DRIVE_ID.test(String(body.image.driveId || ""))) {
      image = `podcast/images/${id}.jpg`;
      await copyFromDrive(env, drive, body.image.driveId, image, IMAGE);
      warning = await imageWarning(env, image, "The episode image");
    }
    const ep = {
      id, guid: id, title, description, audio, bytes, duration, image,
      source: body.audio === "draft" ? draft.source : "picked from Drive",
      published: new Date().toISOString(), publishedBy: who,
    };
    const nextEpisodes = [ep, ...episodes.filter((e) => e.id !== id)];
    await putJson(env, "podcast/episodes.json", nextEpisodes);
    if (draft) {
      await b.delete("podcast/draft.json");
      await dropUnused(env, [draft.audio, draft.image], nextEpisodes);
    }
    return json({ ok: true, episode: ep, warning });
  }

  if (body.action === "clear") {
    if (!draft) return json({ ok: true });
    await b.delete("podcast/draft.json");
    await dropUnused(env, [draft.audio, draft.image], episodes);
    return json({ ok: true });
  }

  const id = String(body.id || "");
  if (!ID.test(id)) throw new AppError("Unknown episode");

  if (body.action === "update") {
    const i = episodes.findIndex((e) => e.id === id);
    if (i < 0) throw new AppError("That episode isn't in the feed", 404);
    if ("title" in body) episodes[i].title = clean(body.title, 200) || episodes[i].title;
    if ("description" in body) episodes[i].description = clean(body.description, 4000);
    await putJson(env, "podcast/episodes.json", episodes);
    return json({ ok: true, episode: episodes[i] });
  }

  if (body.action === "remove") {
    const ep = episodes.find((e) => e.id === id);
    if (!ep) throw new AppError("That episode isn't in the feed", 404);
    const rest = episodes.filter((e) => e.id !== id);
    await putJson(env, "podcast/episodes.json", rest);
    if (!ep.imported) await dropUnused(env, [ep.audio, ep.image], [...rest, draft]);
    await dropEpisodeStats(env, id).catch(() => {});
    return json({ ok: true });
  }

  throw new AppError("Unknown action");
});
