// GET /api/activity                 the latest month's events + the months available
// GET /api/activity?month=2026-10   that month's events
// GET /api/activity?key=log/...     one event with its full details
import { AppError } from "../../lib/google.js";
import { json, wrap } from "../../lib/http.js";
import { bucket } from "../../lib/podcast.js";
import { KINDS, logMonths, pruneLog, readEvent, readMonth } from "../../lib/audit.js";

export const onRequestGet = wrap(async (ctx) => {
  const { env, request } = ctx;
  bucket(env);   // explains a missing PODCAST_BUCKET binding
  const url = new URL(request.url);
  const key = url.searchParams.get("key");
  if (key) {
    const event = await readEvent(env, key);
    if (!event) throw new AppError("That entry isn't in the log", 404);
    return json(event);
  }
  const months = await logMonths(env);
  const want = url.searchParams.get("month");
  const m = want && /^\d{4}-\d{2}$/.test(want) ? want : months[0] || new Date().toISOString().slice(0, 7);
  const events = await readMonth(env, m);
  if (ctx.waitUntil) ctx.waitUntil(pruneLog(env, months).catch(() => {}));
  return json({ month: m, months, kinds: KINDS, events });
});
