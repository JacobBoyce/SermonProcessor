// GET /podcast/feed.xml: the public podcast feed that Spotify, Apple and podcast apps read.
import { buildFeed, getEpisodes, getShow } from "../../lib/podcast.js";

export async function onRequestGet({ env, request }) {
  if (!env.PODCAST_BUCKET) return new Response("Podcast not set up", { status: 503 });
  const origin = new URL(request.url).origin;
  const [show, episodes] = await Promise.all([getShow(env), getEpisodes(env)]);
  return new Response(buildFeed(show, episodes, origin), {
    headers: { "content-type": "application/rss+xml; charset=utf-8", "cache-control": "public, max-age=300" },
  });
}
