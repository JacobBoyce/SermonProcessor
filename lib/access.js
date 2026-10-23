// Checks Cloudflare Access sign-in on every API request.
//
// Cloudflare Access sits in front of the site and asks people to sign in (an
// emailed one-time code, or Google). After sign-in it adds a signed token to each
// request (the Cf-Access-Jwt-Assertion header). We check that token here too, so a
// gap in the Access setup (say, a preview link left uncovered) can't let anyone in.
//
// Settings in Cloudflare: ACCESS_TEAM_DOMAIN (e.g. "sermonprocessor.cloudflareaccess.com")
// and ACCESS_AUD (the application's Audience tag). With neither set, this check is off.

let certs = { domain: "", keys: null, fetched: 0 };

export const accessConfigured = (env) => Boolean(env.ACCESS_TEAM_DOMAIN && env.ACCESS_AUD);

function teamDomain(env) {
  return String(env.ACCESS_TEAM_DOMAIN).trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
}

function b64url(s) {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

async function signingKeys(domain, force = false) {
  const fresh = certs.domain === domain && certs.keys && Date.now() - certs.fetched < 3600_000;
  if (fresh && !force) return certs.keys;
  const r = await fetch(`https://${domain}/cdn-cgi/access/certs`);
  if (!r.ok) throw new Error(`couldn't load Cloudflare Access keys (${r.status})`);
  const { keys = [] } = await r.json();
  certs = { domain, keys, fetched: Date.now() };
  return keys;
}

// Returns { email } for a valid sign-in, or throws with a reason.
export async function verifyAccess(request, env) {
  const token = request.headers.get("cf-access-jwt-assertion") || cookie(request, "CF_Authorization");
  if (!token) throw new Error("not signed in");
  const [h, p, sig] = token.split(".");
  if (!h || !p || !sig) throw new Error("malformed sign-in token");
  const header = JSON.parse(new TextDecoder().decode(b64url(h)));
  const payload = JSON.parse(new TextDecoder().decode(b64url(p)));
  if (header.alg !== "RS256") throw new Error("unexpected token type");

  const domain = teamDomain(env);
  let keys = await signingKeys(domain);
  let jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) {                                   // keys rotate; refresh once
    keys = await signingKeys(domain, true);
    jwk = keys.find((k) => k.kid === header.kid);
  }
  if (!jwk) throw new Error("unknown signing key");
  const key = await crypto.subtle.importKey("jwk", { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64url(sig), new TextEncoder().encode(`${h}.${p}`));
  if (!ok) throw new Error("bad signature");

  const now = Date.now() / 1000;
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes(String(env.ACCESS_AUD).trim())) throw new Error("token is for a different application");
  if (payload.iss !== `https://${domain}`) throw new Error("token is from a different team");
  if (typeof payload.exp !== "number" || payload.exp < now - 30) throw new Error("sign-in expired");
  if (typeof payload.nbf === "number" && payload.nbf > now + 30) throw new Error("token not valid yet");
  return { email: payload.email || payload.common_name || "" };
}

function cookie(request, name) {
  const all = request.headers.get("cookie") || "";
  const m = all.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return m ? decodeURIComponent(m[1]) : "";
}
