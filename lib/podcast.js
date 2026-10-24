// Podcast storage and feed, using the R2 bucket bound to the site as PODCAST_BUCKET.
// The GitHub worker writes drafts (podcast/drafts/<id>.json + audio + cover); the
// web app publishes them into podcast/episodes.json and serves the feed from it.

import { AppError } from "./google.js";

export const SHOW_DEFAULTS = {
  title: "Sermon Processor test podcast",
  description: "A test feed for the Sermon Processor. Not for listeners.",
  author: "",
  email: "",
  language: "en-us",
  category: "Religion & Spirituality",
  subcategory: "Christianity",
  explicit: false,
  image: null,          // R2 key of the square show cover
  link: "",
  test: true,           // test feeds ask directories not to list them (itunes:block)
};

export function bucket(env) {
  if (!env.PODCAST_BUCKET) throw new AppError("The podcast bucket isn't linked to this site yet (binding PODCAST_BUCKET).", 500);
  return env.PODCAST_BUCKET;
}

export async function getJson(env, key, fallback) {
  const obj = await bucket(env).get(key);
  if (!obj) return fallback;
  try { return await obj.json(); } catch { return fallback; }
}

export async function putJson(env, key, value) {
  await bucket(env).put(key, JSON.stringify(value, null, 2), { httpMetadata: { contentType: "application/json" } });
}

export const getShow = async (env) => ({ ...SHOW_DEFAULTS, ...(await getJson(env, "podcast/show.json", {})) });
export const getEpisodes = async (env) => (await getJson(env, "podcast/episodes.json", [])) || [];

export async function getDrafts(env) {
  const list = await bucket(env).list({ prefix: "podcast/drafts/" });
  const drafts = await Promise.all(list.objects.map((o) => getJson(env, o.key, null)));
  return drafts.filter(Boolean).sort((a, b) => String(b.created).localeCompare(String(a.created)));
}

// ---------------------------------------------------------------- feed

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c]));
const cdata = (s) => `<![CDATA[${String(s ?? "").replaceAll("]]>", "]]]]><![CDATA[>")}]]>`;

// Plain text with blank-line paragraphs and bare links -> simple HTML for podcast apps.
export function textToHtml(text) {
  const linkify = (t) => esc(t).replace(/https?:\/\/[^\s<]+/g, (u) => `<a href="${u}">${u}</a>`);
  return String(text ?? "").trim().split(/\n\s*\n/).map((p) => `<p>${linkify(p).replace(/\n/g, "<br>")}</p>`).join("");
}

function rfc822(iso) {
  return new Date(iso).toUTCString().replace("GMT", "+0000");
}

export function mediaUrl(origin, key) {
  return `${origin}/podcast/media/${key.replace(/^podcast\//, "")}`;
}

export function buildFeed(show, episodes, origin) {
  const feedUrl = `${origin}/podcast/feed.xml`;
  const items = [...episodes]
    .sort((a, b) => String(b.published).localeCompare(String(a.published)))
    .map((e) => {
      const audio = e.audioUrl || mediaUrl(origin, e.audio);
      const image = e.imageUrl || (e.image ? mediaUrl(origin, e.image) : null);
      return `    <item>
      <title>${esc(e.title)}</title>
      <description>${cdata(e.descriptionHtml || textToHtml(e.description))}</description>
      <itunes:summary>${esc(e.description)}</itunes:summary>
      <guid isPermaLink="false">${esc(e.guid || e.id)}</guid>
      <pubDate>${rfc822(e.published)}</pubDate>
      <enclosure url="${esc(audio)}" length="${Number(e.bytes) || 0}" type="audio/mpeg"/>
      <itunes:duration>${Number(e.duration) || 0}</itunes:duration>${image ? `
      <itunes:image href="${esc(image)}"/>` : ""}
      <itunes:episodeType>full</itunes:episodeType>
      <itunes:explicit>${show.explicit ? "true" : "false"}</itunes:explicit>
    </item>`;
    })
    .join("\n");
  const cover = show.image ? mediaUrl(origin, show.image) : null;
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>${esc(show.title)}</title>
    <link>${esc(show.link || feedUrl)}</link>
    <atom:link href="${esc(feedUrl)}" rel="self" type="application/rss+xml"/>
    <language>${esc(show.language)}</language>
    <description>${cdata(show.description)}</description>
    <itunes:summary>${esc(show.description)}</itunes:summary>
    <itunes:author>${esc(show.author)}</itunes:author>
    <itunes:owner><itunes:name>${esc(show.author)}</itunes:name><itunes:email>${esc(show.email)}</itunes:email></itunes:owner>${cover ? `
    <itunes:image href="${esc(cover)}"/>
    <image><url>${esc(cover)}</url><title>${esc(show.title)}</title><link>${esc(show.link || feedUrl)}</link></image>` : ""}
    <itunes:category text="${esc(show.category)}">${show.subcategory ? `<itunes:category text="${esc(show.subcategory)}"/>` : ""}</itunes:category>
    <itunes:explicit>${show.explicit ? "true" : "false"}</itunes:explicit>
    <itunes:type>episodic</itunes:type>${show.test ? `
    <itunes:block>Yes</itunes:block>` : ""}
    <lastBuildDate>${rfc822(new Date().toISOString())}</lastBuildDate>
${items}
  </channel>
</rss>
`;
}
