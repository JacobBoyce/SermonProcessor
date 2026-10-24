// Who reads the podcast: which apps checked the feed, and which downloaded each episode.
// Stored as tiny objects in the podcast bucket whose counts live in custom metadata,
// so one bucket listing returns everything without opening each object.
//
//   podcast/stats/feed/<app>          last time <app> checked the feed
//   podcast/stats/ep/<id>/<app>       when <app> first and last fetched episode <id>, and how many times
//
// Counts are approximate (two requests at the same instant can count once). Writes
// happen after the response is sent (waitUntil), so listeners never wait on them.

const APPS = [
  [/spotify/i, "Spotify"],
  [/iTMS|AirPodcasts|^Podcasts\/|Apple ?Podcasts|iTunes/i, "Apple Podcasts"],
  [/AppleCoreMedia/i, "Apple device"],
  [/Pocket ?Casts/i, "Pocket Casts"],
  [/Overcast/i, "Overcast"],
  [/Amazon ?Music|AmazonMusic|Alexa/i, "Amazon Music"],
  [/YouTube|Google-Podcast|GoogleOther|Google/i, "Google / YouTube"],
  [/PodcastAddict/i, "Podcast Addict"],
  [/Castbox/i, "Castbox"],
  [/Castro/i, "Castro"],
  [/iHeart/i, "iHeartRadio"],
  [/Podverse|Fountain|Podcast ?Guru|PodcastIndex|Podnews|TrueFans/i, "Podcast Index apps"],
  [/Deezer/i, "Deezer"],
  [/Pandora|SiriusXM/i, "Pandora / SiriusXM"],
  [/bot|crawler|spider|curl|wget|python|feed ?validator|feedburner/i, "Bots and checkers"],
  [/Mozilla/i, "Web browser"],
];

export function appFromUA(ua = "") {
  for (const [re, name] of APPS) if (re.test(ua)) return name;
  return "Other";
}

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const now = () => new Date().toISOString();

// Requests from the app's own preview players don't count as listeners.
function fromOurApp(request) {
  const ref = request.headers.get("referer") || "";
  try { return ref && new URL(ref).host === new URL(request.url).host; } catch { return false; }
}

async function bump(bucket, key, app, minGapMs = 0) {
  const old = await bucket.head(key);
  const m = old?.customMetadata || {};
  if (minGapMs && m.last && Date.now() - Date.parse(m.last) < minGapMs) return;
  await bucket.put(key, "", {
    customMetadata: { app, first: m.first || now(), last: now(), count: String((Number(m.count) || 0) + 1) },
  });
}

export function recordFeedCheck(ctx) {
  const { env, request } = ctx;
  if (!env.PODCAST_BUCKET || fromOurApp(request)) return;
  const app = appFromUA(request.headers.get("user-agent") || "");
  // Some apps check every few minutes; one write per app per 10 minutes is plenty.
  ctx.waitUntil(bump(env.PODCAST_BUCKET, `podcast/stats/feed/${slug(app)}`, app, 600_000).catch(() => {}));
}

export function recordDownload(ctx, episodeId, rangeStart) {
  const { env, request } = ctx;
  if (!env.PODCAST_BUCKET || fromOurApp(request)) return;
  if (rangeStart > 0) return;           // later chunks of the same download or a seek, not a new listen
  const app = appFromUA(request.headers.get("user-agent") || "");
  ctx.waitUntil(bump(env.PODCAST_BUCKET, `podcast/stats/ep/${episodeId}/${slug(app)}`, app).catch(() => {}));
}

async function listAll(bucket, prefix) {
  const out = [];
  let cursor;
  do {
    const page = await bucket.list({ prefix, cursor, include: ["customMetadata"] });
    out.push(...page.objects);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return out;
}

// { feed: [{app, first, last, count}], episodes: { <id>: [{app, first, last, count}] } }
export async function readStats(env) {
  const [feedObjs, epObjs] = await Promise.all([
    listAll(env.PODCAST_BUCKET, "podcast/stats/feed/"),
    listAll(env.PODCAST_BUCKET, "podcast/stats/ep/"),
  ]);
  const row = (o) => ({ app: o.customMetadata?.app || "Other", first: o.customMetadata?.first || "",
    last: o.customMetadata?.last || "", count: Number(o.customMetadata?.count) || 0 });
  const episodes = {};
  for (const o of epObjs) {
    const id = o.key.split("/")[3];
    (episodes[id] ||= []).push(row(o));
  }
  const byLast = (a, b) => b.last.localeCompare(a.last);
  for (const k in episodes) episodes[k].sort(byLast);
  return { feed: feedObjs.map(row).sort(byLast), episodes };
}

export async function dropEpisodeStats(env, id) {
  const objs = await listAll(env.PODCAST_BUCKET, `podcast/stats/ep/${id}/`);
  if (objs.length) await env.PODCAST_BUCKET.delete(objs.map((o) => o.key));
}
