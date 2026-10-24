// Cloudflare Worker entry: serves the setup screen from /web and routes /api/*
// to the same handlers used under functions/api (so Pages works too).
import { onRequest as checkPasscode } from "../functions/api/_middleware.js";
import * as files from "../functions/api/files.js";
import * as jobs from "../functions/api/jobs.js";
import * as image from "../functions/api/image/[id].js";
import * as video from "../functions/api/video/[id].js";
import * as podcastApi from "../functions/api/podcast.js";
import * as feed from "../functions/podcast/feed.xml.js";
import * as media from "../functions/podcast/media/[[path]].js";
import { json } from "../lib/http.js";

function route(request, env, ctx) {
  const { pathname } = new URL(request.url);
  const method = request.method;
  const base = { request, env, waitUntil: ctx.waitUntil.bind(ctx), params: {} };
  if (pathname === "/api/files" && method === "GET") return files.onRequestGet(base);
  if (pathname === "/api/jobs" && method === "GET") return jobs.onRequestGet(base);
  if (pathname === "/api/jobs" && method === "POST") return jobs.onRequestPost(base);
  const img = pathname.match(/^\/api\/image\/([\w-]+)$/);
  if (img && method === "GET") return image.onRequestGet({ ...base, params: { id: img[1] } });
  const vid = pathname.match(/^\/api\/video\/([\w-]+)$/);
  if (vid && method === "GET") return video.onRequestGet({ ...base, params: { id: vid[1] } });
  if (pathname === "/api/podcast" && method === "GET") return podcastApi.onRequestGet(base);
  if (pathname === "/api/podcast" && method === "POST") return podcastApi.onRequestPost(base);
  return json({ error: "Not found" }, 404);
}

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    if (pathname.startsWith("/api/")) {
      const c = { request, env, data: {}, next: () => route(request, env, ctx) };
      return checkPasscode(c);
    }
    // The podcast feed and its files are public, for podcast apps.
    if (pathname === "/podcast/feed.xml") return feed.onRequestGet({ request, env, waitUntil: ctx.waitUntil.bind(ctx) });
    if (pathname.startsWith("/podcast/media/")) {
      return media.onRequest({ request, env, waitUntil: ctx.waitUntil.bind(ctx), params: { path: pathname.slice("/podcast/media/".length).split("/") } });
    }
    return env.ASSETS.fetch(request);
  },
};
