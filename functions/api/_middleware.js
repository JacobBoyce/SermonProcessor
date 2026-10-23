// Guards every /api request.
//  - With Cloudflare Access set up (ACCESS_TEAM_DOMAIN + ACCESS_AUD), the sign-in is
//    checked on every request.
//  - With APP_PASSCODE set, the passcode is also required. Once Access is on, the
//    passcode can be removed to drop the passcode screen.
//  - With neither, the app stays locked.
import { accessConfigured, verifyAccess } from "../../lib/access.js";
import { json } from "../../lib/http.js";

function same(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function onRequest(ctx) {
  const { request, env, next } = ctx;
  const access = accessConfigured(env);
  if (!access && !env.APP_PASSCODE) {
    return json({ error: "Set APP_PASSCODE or Cloudflare Access in Cloudflare to turn the app on" }, 500);
  }
  ctx.data = ctx.data || {};
  if (access) {
    try {
      ctx.data.user = await verifyAccess(request, env);
    } catch (err) {
      return json({ error: `Sign in through Cloudflare Access to use this app (${err.message}).`, signIn: true }, 401);
    }
  }
  const url = new URL(request.url);
  // /api/session tells the page whether it needs to ask for the passcode.
  if (url.pathname === "/api/session") {
    return json({ passcode: Boolean(env.APP_PASSCODE), email: ctx.data.user?.email || null, access });
  }
  if (env.APP_PASSCODE) {
    // Images and video are loaded by tags that can't send headers, so they pass the code as ?k=
    const given = request.headers.get("x-passcode") || url.searchParams.get("k") || "";
    if (!same(given, env.APP_PASSCODE)) return json({ error: "Wrong passcode" }, 401);
  }
  return next();
}
