// Cloudflare Worker entry: serves the setup screen from /web and routes /api/*
// to the same handlers used under functions/api (so Pages works too).
import { onRequest as checkPasscode } from "../functions/api/_middleware.js";
import * as files from "../functions/api/files.js";
import * as jobs from "../functions/api/jobs.js";
import * as image from "../functions/api/image/[id].js";
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
  return json({ error: "Not found" }, 404);
}

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    if (pathname.startsWith("/api/")) {
      return checkPasscode({ request, env, next: () => route(request, env, ctx) });
    }
    return env.ASSETS.fetch(request);
  },
};
