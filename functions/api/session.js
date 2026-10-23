// GET /api/session: answered by _middleware.js (whether a passcode is needed, and who
// is signed in through Cloudflare Access). This file makes sure the route exists.
import { json } from "../../lib/http.js";

export const onRequestGet = async ({ data }) => json({ email: data?.user?.email || null });
