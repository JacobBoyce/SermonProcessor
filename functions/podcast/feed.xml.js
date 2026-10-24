// GET /podcast/feed.xml: the public podcast feed that Spotify, Apple and podcast apps read.
import { buildFeed, getEpisodes, getShow } from "../../lib/podcast.js";
import { recordFeedCheck } from "../../lib/stats.js";

export async function onRequestGet(ctx) {
  const { env, request } = ctx;
  if (!env.PODCAST_BUCKET) return new Response("Podcast not set up", { status: 503 });
  recordFeedCheck(ctx);
  const origin = new URL(request.url).origin;
  const [show, episodes] = await Promise.all([getShow(env), getEpisodes(env)]);
  return new Response(buildFeed(show, episodes, origin), {
    headers: { "content-type": "application/rss+xml; charset=utf-8", "cache-control": "public, max-age=300" },
  });
}
