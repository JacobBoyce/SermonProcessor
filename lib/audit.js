// Activity log: who did what in the app, for accountability and debugging.
// Written by the API itself (not the browser), so it can't be skipped or faked by a page.
//
//   log/<YYYY-MM>/<ISO time>-<random>.json   one event; the short fields are also in
//                                            custom metadata, so a listing shows them all
//   log/seen/<email>                          throttles "opened the app" to once per 6 hours
//
// Months older than KEEP_MONTHS are deleted when the log is viewed.

const KEEP_MONTHS = 12;
const rand = () => [...crypto.getRandomValues(new Uint8Array(4))].map((b) => b.toString(16).padStart(2, "0")).join("");
const month = (d = new Date()) => d.toISOString().slice(0, 7);

export const whoIs = (ctx) => ctx.data?.user?.email || "passcode user";

// Categories shown as filters in the viewer.
export const KINDS = ["sign-in", "render", "podcast", "youtube", "description", "settings"];

// Record one event after the response is sent. Never throws: logging must not break an action.
export function logEvent(ctx, kind, summary, details = {}) {
  const env = ctx.env;
  if (!env.PODCAST_BUCKET) return;
  const at = new Date().toISOString();
  const who = whoIs(ctx);
  const event = { at, who, kind, summary: String(summary).slice(0, 500), details };
  const key = `log/${month()}/${at}-${rand()}.json`;
  const put = env.PODCAST_BUCKET.put(key, JSON.stringify(event), {
    httpMetadata: { contentType: "application/json" },
    customMetadata: { at, who: who.slice(0, 200), kind, summary: event.summary.slice(0, 900) },
  }).catch(() => {});
  if (ctx.waitUntil) ctx.waitUntil(put); else return put;
}

// "Opened the app", at most once per 6 hours per person.
export function logVisit(ctx) {
  const env = ctx.env;
  if (!env.PODCAST_BUCKET) return;
  const who = whoIs(ctx);
  const key = `log/seen/${who.toLowerCase().replace(/[^a-z0-9@._-]/g, "_")}`;
  const work = (async () => {
    const seen = await env.PODCAST_BUCKET.head(key);
    const last = Date.parse(seen?.customMetadata?.at || "");
    if (last && Date.now() - last < 6 * 3600_000) return;
    await env.PODCAST_BUCKET.put(key, "", { customMetadata: { at: new Date().toISOString() } });
    await logEvent({ ...ctx, waitUntil: null }, "sign-in", "Opened the app");
  })().catch(() => {});
  if (ctx.waitUntil) ctx.waitUntil(work);
}

async function listAll(bucket, opts) {
  const objects = [], prefixes = [];
  let cursor;
  do {
    const page = await bucket.list({ ...opts, cursor });
    objects.push(...page.objects);
    prefixes.push(...(page.delimitedPrefixes || []));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return { objects, prefixes };
}

// The months that have entries, newest first, e.g. ["2026-11", "2026-10"].
export async function logMonths(env) {
  const { prefixes } = await listAll(env.PODCAST_BUCKET, { prefix: "log/", delimiter: "/" });
  return prefixes.map((p) => p.slice(4, -1)).filter((m) => /^\d{4}-\d{2}$/.test(m)).sort().reverse();
}

// One month's events, newest first (short fields only; details come from readEvent).
export async function readMonth(env, m) {
  const { objects } = await listAll(env.PODCAST_BUCKET, { prefix: `log/${m}/`, include: ["customMetadata"] });
  return objects
    .map((o) => ({ key: o.key, ...(o.customMetadata || {}) }))
    .sort((a, b) => String(b.at).localeCompare(String(a.at)));
}

export async function readEvent(env, key) {
  if (!/^log\/\d{4}-\d{2}\/[\w:.-]+\.json$/.test(key)) return null;
  const obj = await env.PODCAST_BUCKET.get(key);
  return obj ? obj.json().catch(() => null) : null;
}

// Delete months older than KEEP_MONTHS (runs after a viewer request).
export async function pruneLog(env, months) {
  const cutoff = new Date();
  cutoff.setUTCMonth(cutoff.getUTCMonth() - KEEP_MONTHS);
  const old = months.filter((m) => m < month(cutoff));
  for (const m of old) {
    const { objects } = await listAll(env.PODCAST_BUCKET, { prefix: `log/${m}/` });
    for (let i = 0; i < objects.length; i += 1000) await env.PODCAST_BUCKET.delete(objects.slice(i, i + 1000).map((o) => o.key));
  }
}
