// GET /api/describe?id=<request id>: the result of an AI description started with
// POST /api/jobs {action:"describe"}. The worker writes ai/<id>.json in the podcast bucket.
import { AppError } from "../../lib/google.js";
import { json, wrap } from "../../lib/http.js";
import { bucket } from "../../lib/podcast.js";

export const onRequestGet = wrap(async ({ env, request }) => {
  const id = new URL(request.url).searchParams.get("id") || "";
  if (!/^[0-9a-f]{32}$/.test(id)) throw new AppError("Unknown description request");
  const obj = await bucket(env).get(`ai/${id}.json`);
  if (!obj) return json({ status: "queued" });
  const data = await obj.json().catch(() => ({ status: "error", error: "Unreadable result" }));
  return json(data);
});
