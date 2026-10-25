// Google Drive helpers for the web app's API (Cloudflare Pages Functions).
// Signs in with the same refresh token the GitHub worker uses.

const API = "https://www.googleapis.com/drive/v3";
const FOLDER = "application/vnd.google-apps.folder";
const VIDEO_EXT = [".mp4", ".mov", ".m4v", ".mkv", ".mts", ".avi"];
const IMAGE_EXT = [".png", ".jpg", ".jpeg"];

let cached = { token: "", expires: 0 };

export class AppError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

export function folderIdFrom(value = "") {
  let v = String(value).trim();
  if (v.includes("/folders/")) v = v.split("/folders/")[1];
  return v.split(/[?&#/\s]/)[0];
}

async function token(env) {
  if (cached.token && Date.now() < cached.expires - 60_000) return cached.token;
  for (const k of ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REFRESH_TOKEN"]) {
    if (!env[k]) throw new AppError(`Missing setting ${k} in Cloudflare`, 500);
  }
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: env.GOOGLE_REFRESH_TOKEN,
      grant_type: "refresh_token",
    }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new AppError(`Google sign-in failed: ${data.error_description || data.error || r.status}`, 502);
  cached = { token: data.access_token, expires: Date.now() + (data.expires_in || 3600) * 1000 };
  return cached.token;
}

export async function drive(env, path, params = {}, raw = false, extraHeaders = {}) {
  const url = new URL(API + path);
  for (const [k, v] of Object.entries({ supportsAllDrives: "true", ...params })) url.searchParams.set(k, v);
  const r = await fetch(url, { headers: { ...extraHeaders, Authorization: `Bearer ${await token(env)}` } });
  if (raw) return r;
  if (r.status === 404) throw new AppError("Drive couldn't find that folder. Check DRIVE_ROOT_FOLDER_ID.", 404);
  if (!r.ok) throw new AppError(`Drive said ${r.status}: ${(await r.text()).slice(0, 200)}`, 502);
  return r.json();
}

const FIELDS = "id,name,mimeType,size,modifiedTime,videoMediaMetadata(durationMillis,width,height)";

async function children(env, folderId) {
  const files = [];
  let pageToken = "";
  do {
    const d = await drive(env, "/files", {
      q: `'${folderId}' in parents and trashed = false`,
      fields: `nextPageToken,files(${FIELDS})`,
      includeItemsFromAllDrives: "true",
      pageSize: "1000",
      orderBy: "name",
      ...(pageToken ? { pageToken } : {}),
    });
    files.push(...(d.files || []));
    pageToken = d.nextPageToken || "";
  } while (pageToken);
  return files;
}

async function walk(env, folderId, prefix = "", depth = 0, out = []) {
  const items = await children(env, folderId);
  await Promise.all(
    items.map(async (f) => {
      if (f.mimeType === FOLDER) {
        if (depth < 5) await walk(env, f.id, `${prefix}${f.name}/`, depth + 1, out);
      } else {
        out.push({ ...f, path: prefix + f.name });
      }
    }),
  );
  return out;
}

const ext = (name) => (name.match(/\.[^.]+$/)?.[0] || "").toLowerCase();
const stemPath = (path) => path.replace(/\.[^./]+$/, "").toLowerCase();

export async function listFiles(env) {
  const root = folderIdFrom(env.DRIVE_ROOT_FOLDER_ID);
  if (!root) throw new AppError("Set DRIVE_ROOT_FOLDER_ID in Cloudflare", 500);
  const top = await children(env, root);
  const find = (name) => {
    const f = top.find((x) => x.mimeType === FOLDER && x.name.toLowerCase() === name.toLowerCase());
    if (!f) throw new AppError(`Make a folder named '${name}' in your Sermon Cutter folder`, 404);
    return f;
  };
  const [incoming, thumbs, graphics, output] = ["Incoming", "Thumbnails", "Graphics", "Output"].map(find);
  const [inFiles, thumbFiles, graphicFiles, outFiles] = await Promise.all([
    walk(env, incoming.id),
    walk(env, thumbs.id),
    walk(env, graphics.id),
    walk(env, output.id),
  ]);

  // Match by the same subfolders first; if the folders don't line up, by name
  // anywhere, as long as only one file has that name.
  const index = (files, exts) => {
    const byPath = new Map(), byName = new Map();
    for (const f of files) {
      if (!exts.includes(ext(f.name))) continue;
      byPath.set(stemPath(f.path), f);
      const k = stemPath(f.name);
      byName.set(k, byName.has(k) ? null : f);
    }
    return (path) => byPath.get(stemPath(path)) || byName.get(stemPath(path.split("/").pop())) || null;
  };
  const thumbFor = index(thumbFiles, IMAGE_EXT);
  const textFor = index(inFiles, [".txt"]);

  const videos = inFiles
    .filter((f) => VIDEO_EXT.includes(ext(f.name)) || f.mimeType.startsWith("video/"))
    .map((f) => {
      const t = thumbFor(f.path);
      const own = textFor(f.path);
      const m = f.videoMediaMetadata || {};
      return {
        id: f.id,
        path: f.path,
        size: Number(f.size || 0),
        modified: f.modifiedTime,
        duration: m.durationMillis ? Number(m.durationMillis) / 1000 : null,
        width: m.width || null,
        height: m.height || null,
        thumbnail: t ? { id: t.id, name: t.name } : null,
        descriptionFile: own ? own.name : null,
      };
    })
    .sort((a, b) => (b.modified || "").localeCompare(a.modified || ""));

  return {
    videos,
    graphics: graphicFiles
      .filter((f) => IMAGE_EXT.includes(ext(f.name)))
      .map((f) => ({ id: f.id, name: f.name, path: f.path, folder: f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/")) : "" }))
      .sort((a, b) => a.folder.localeCompare(b.folder) || a.name.localeCompare(b.name)),
    outputFolder: `https://drive.google.com/drive/folders/${output.id}`,
    // Videos to upload to YouTube on their own: edited ones in Output first, then raw ones in Incoming.
    uploadable: [...outFiles.map((f) => ({ ...f, where: "Output" })), ...inFiles.map((f) => ({ ...f, where: "Incoming" }))]
      .filter((f) => VIDEO_EXT.includes(ext(f.name)) || String(f.mimeType).startsWith("video/"))
      .map((f) => ({ id: f.id, name: f.name, path: `${f.where}/${f.path}`, size: Number(f.size || 0), modified: f.modifiedTime }))
      .sort((a, b) => (b.modified || "").localeCompare(a.modified || "")),
    // For picking a podcast episode's audio and image by hand.
    audio: [...outFiles.map((f) => ({ ...f, where: "Output" })), ...inFiles.map((f) => ({ ...f, where: "Incoming" }))]
      .filter((f) => ext(f.name) === ".mp3")
      .map((f) => ({ id: f.id, name: f.name, path: `${f.where}/${f.path}`, size: Number(f.size || 0), modified: f.modifiedTime }))
      .sort((a, b) => (b.modified || "").localeCompare(a.modified || "")),
    thumbnails: thumbFiles
      .filter((f) => IMAGE_EXT.includes(ext(f.name)))
      .map((f) => ({ id: f.id, name: f.name, path: f.path }))
      .sort((a, b) => a.path.localeCompare(b.path)),
  };
}
