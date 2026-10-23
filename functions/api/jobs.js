// GET /api/jobs: recent render runs.  POST /api/jobs: start a render on GitHub.
import { AppError, drive } from "../../lib/google.js";
import { json, wrap } from "../../lib/http.js";

const WORKFLOW = "process.yml";

async function github(env, path, init = {}) {
  if (!env.GITHUB_TOKEN) throw new AppError("Missing setting GITHUB_TOKEN in Cloudflare", 500);
  const repo = env.GITHUB_REPO || "JacobBoyce/SermonProcessor";
  const r = await fetch(`https://api.github.com/repos/${repo}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "sermon-processor",
      ...(init.body ? { "content-type": "application/json" } : {}),
    },
  });
  if (!r.ok) {
    const text = await r.text();
    const hint = r.status === 401 || r.status === 403 ? " Check that GITHUB_TOKEN is valid and can run Actions." : "";
    throw new AppError(`GitHub said ${r.status}: ${text.slice(0, 200)}.${hint}`, 502);
  }
  return r.status === 204 ? null : r.json();
}

// Progress for a run in flight: the worker saves it as private labels (appProperties)
// on the source video in Drive about every 15 seconds.
async function progressFor(env, runId) {
  try {
    const d = await drive(env, "/files", {
      q: `appProperties has { key='sp_run' and value='${runId}' } and trashed = false`,
      fields: "files(appProperties)", includeItemsFromAllDrives: "true", pageSize: "1",
    });
    const p = d.files?.[0]?.appProperties;
    if (!p) return null;
    return {
      stage: p.sp_stage || "",
      pct: p.sp_pct === "" || p.sp_pct == null ? null : Number(p.sp_pct),
      eta: p.sp_eta === "" || p.sp_eta == null ? null : Number(p.sp_eta),
      at: p.sp_at ? Number(p.sp_at) * 1000 : null,
    };
  } catch {
    return null;   // progress is extra; never break the run list
  }
}

export const onRequestGet = wrap(async ({ env }) => {
  const d = await github(env, `/actions/workflows/${WORKFLOW}/runs?per_page=10&event=workflow_dispatch`);
  const repo = env.GITHUB_REPO || "JacobBoyce/SermonProcessor";
  const runs = d.workflow_runs || [];
  const live = await Promise.all(runs.map((r) => (r.status === "completed" ? null : progressFor(env, r.id))));
  return json({
    all: `https://github.com/${repo}/actions/workflows/${WORKFLOW}`,
    runs: runs.map((r, i) => ({
      progress: live[i],
      id: r.id,
      label: r.display_title,
      status: r.status,
      conclusion: r.conclusion,
      created: r.created_at,
      updated: r.updated_at,
      url: r.html_url,
    })),
  });
});

export const onRequestPost = wrap(async ({ env, request }) => {
  const body = await request.json().catch(() => null);
  const job = body?.job;
  if (!job || typeof job.source !== "string" || !Array.isArray(job.outputs) || !job.outputs.length) {
    throw new AppError("The job needs a source video and at least one output");
  }
  const height = body.height === "1080" ? "1080" : "source";
  const label = String(body.label || `Render ${job.source}`).slice(0, 120);
  const text = JSON.stringify(job);
  if (text.length > 60_000) throw new AppError("The job is too large");
  await github(env, `/actions/workflows/${WORKFLOW}/dispatches`, {
    method: "POST",
    body: JSON.stringify({ ref: "main", inputs: { action: "render", job: text, output_height: height, label } }),
  });
  return json({ ok: true });
});
