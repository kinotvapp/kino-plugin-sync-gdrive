// Sync Google Drive (sync-gdrive): Kino's cross-device sync through the person's own Google Drive. EXPERIMENTAL.
//
// Kino encrypts the snapshot and hands this plugin an opaque blob (base64). The plugin keeps it as ONE file, kino-sync.bin,
// inside a "Kino Sync" folder in the person's Drive. The scope is `drive.file`: the plugin only ever sees the files IT
// created (measured against the real Google: `drive.appdata`, the hidden folder, is refused in the device flow with
// "Invalid device flow scope"; `drive.file` is accepted), so the person's own files stay out of reach. Google only ever
// holds ciphertext: the key is derived by Kino from the "syncKey" setting and is never sent anywhere.
//
// Signing in is Google's device flow (the one TV apps use): the plugin asks for a code, the person types it at
// google.com/device on any other screen, and the plugin trades the code for a refresh token kept on THIS device only
// (`refreshToken` has "sync": false). Every device connects on its own; the copy in Drive is the same for all.
//
// Drive cannot make a write conditional on the version the way a database can, so a push is "check, write, check again":
//   1. look at the file's version; a different one than the one Kino pulled is a conflict;
//   2. write the file and a random tag (appProperties.w) in ONE multipart request;
//   3. read the tag back; if it is not ours, someone wrote in between: conflict, and Kino pulls, merges and pushes again.
// Two devices writing within the same second can still lose one write for a moment; Kino's merge brings it back on the
// next round because every device keeps its own data.

const es = () => !String(kino.lang || "es").toLowerCase().startsWith("en");
const t = (esText, enText) => (es() ? esText : enText);

const FILE_NAME = "kino-sync.bin";
const SCOPE = "https://www.googleapis.com/auth/drive.file";
const FOLDER_NAME = "Kino Sync";
const OAUTH = "https://oauth2.googleapis.com";
const DRIVE = "https://www.googleapis.com";
const DEFAULT_VERIFY = "https://www.google.com/device";

/** A typed error for Kino that also keeps the person's sentence where this plugin can read it back (`say`). */
function fail(code, detail, say) {
  const e = say ? kino.error(code, detail, { userMessage: say }) : kino.error(code, detail);
  try { e.say = say || null; } catch (_) { /* a frozen error just has no sentence */ }
  return e;
}

const form = (o) => Object.entries(o).map(([k, v]) => encodeURIComponent(k) + "=" + encodeURIComponent(String(v))).join("&");

function readStore(key) {
  try { const v = kino.storage.get(key); return v ? JSON.parse(v) : null; } catch (_) { return null; }
}
function writeStore(key, value) {
  try { kino.storage.set(key, JSON.stringify(value)); } catch (e) { kino.log("storage write refused: " + key); }
}

function client() {
  const id = String(kino.config.get("clientId") || "").trim();
  const secret = String(kino.config.get("clientSecret") || "").trim();
  if (!id || !secret) {
    throw fail("auth_required", "client missing", t("Falta el cliente de Google (en Avanzado).", "The Google client is missing (under Advanced)."));
  }
  return { id, secret };
}

// --- OAuth ---

/** One POST to Google's OAuth host: the status and the parsed JSON (an empty object when the body is not JSON). */
async function oauthPost(path, params) {
  let r;
  try {
    r = await kino.fetch(OAUTH + path, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form(params),
      redirect: "manual",
      cookies: false,
      timeoutMs: 30000,
    });
  } catch (e) {
    if (e && e.code === "rate_limited") throw kino.error("rate_limited", "kino.fetch budget");
    throw fail("unavailable", "oauth unreachable: " + (e && e.code), t("No se pudo llegar a Google. Revisa tu conexión.", "Could not reach Google. Check your connection."));
  }
  let json = {};
  try { json = r.json() || {}; } catch (_) { /* not JSON */ }
  return { status: r.status, json };
}

/** A valid access token: the cached one, or a new one from the refresh token. */
async function accessToken(force) {
  if (!force) {
    const c = readStore("tok");
    if (c && c.token && Number(c.exp) > Date.now() + 60000) return c.token;
  }
  const { id, secret } = client();
  const refresh = String(kino.config.get("refreshToken") || "").trim();
  if (!refresh) {
    throw fail("auth_required", "no refresh token", t("Este aparato no está conectado a Google. Toca Conectar con Google.", "This device is not connected to Google. Tap Connect with Google."));
  }
  const r = await oauthPost("/token", { client_id: id, client_secret: secret, refresh_token: refresh, grant_type: "refresh_token" });
  if (r.status === 200 && r.json.access_token) {
    writeStore("tok", { token: r.json.access_token, exp: Date.now() + (Number(r.json.expires_in) || 3600) * 1000 });
    return r.json.access_token;
  }
  writeStore("tok", null);
  if (r.json.error === "invalid_grant" || r.json.error === "invalid_client" || r.status === 401) {
    throw fail("auth_required", "oauth " + (r.json.error || r.status), t("Google ya no acepta la conexión de este aparato (caducó o la quitaste). Toca Conectar con Google otra vez.", "Google no longer accepts this device's connection (it expired or you removed it). Tap Connect with Google again."));
  }
  if (r.status === 429) throw kino.error("rate_limited", "oauth 429");
  throw fail("unavailable", "oauth status " + r.status, t("Google no respondió bien. Intenta de nuevo en un momento.", "Google did not answer properly. Try again in a moment."));
}

// --- Drive ---

/** One request to the Drive API with the access token; a 401 refreshes the token once and tries again. */
async function drive(method, url, options, again) {
  const { headers = {}, body } = options || {};
  const token = await accessToken(false);
  let r;
  try {
    r = await kino.fetch(url, { method, headers: { Authorization: "Bearer " + token, ...headers }, body, redirect: "manual", cookies: false, timeoutMs: 30000 });
  } catch (e) {
    if (e && e.code === "too_large") throw fail("unavailable", "blob too large for kino.fetch", t("La copia es demasiado grande para este plugin.", "The copy is too large for this plugin."));
    if (e && e.code === "rate_limited") throw kino.error("rate_limited", "kino.fetch budget");
    throw fail("unavailable", "drive unreachable: " + (e && e.code), t("No se pudo llegar a Google Drive.", "Could not reach Google Drive."));
  }
  if (r.status === 401 && again !== false) {
    await accessToken(true);
    return drive(method, url, options, false);
  }
  if (r.status === 429) throw kino.error("rate_limited", "429");
  if (r.status === 403) {
    let reason = "";
    try { reason = r.text().slice(0, 400); } catch (_) { /* unreadable */ }
    if (/rateLimit|quotaExceeded/i.test(reason)) throw kino.error("rate_limited", "403 rate");
    if (/storageQuotaExceeded/i.test(reason)) throw fail("unavailable", "drive full", t("Tu Google Drive está lleno.", "Your Google Drive is full."));
    throw fail("auth_required", "403", t("Google no deja a este plugin usar tu Drive. Conecta de nuevo y acepta el permiso.", "Google does not let this plugin use your Drive. Connect again and accept the permission."));
  }
  if (r.status === 401) throw fail("auth_required", "401", t("Google no acepta la conexión. Toca Conectar con Google otra vez.", "Google does not accept the connection. Tap Connect with Google again."));
  if (r.status >= 500) throw fail("unavailable", "drive " + r.status, t("Google Drive no responde ahora mismo.", "Google Drive is not answering right now."));
  return r;
}

/** The copy's file (the oldest if a race made two), or null. With `drive.file` only the files this client created are listed. */
async function findFile() {
  const q = "name='" + FILE_NAME + "' and trashed=false";
  const url = DRIVE + "/drive/v3/files?" + form({ q, orderBy: "createdTime", pageSize: 10, fields: "files(id,version,size,appProperties)" });
  const r = await drive("GET", url);
  if (r.status !== 200) throw kino.error("unavailable", "list status " + r.status);
  const files = (r.json() || {}).files || [];
  return files[0] || null;
}

const isEmpty = (f) => !f || Number(f.size) === 0;

/** The "Kino Sync" folder this client made (the oldest if a race made two), created when there is none. */
async function ensureFolder() {
  const q = "name='" + FOLDER_NAME + "' and mimeType='application/vnd.google-apps.folder' and trashed=false";
  const found = await drive("GET", DRIVE + "/drive/v3/files?" + form({ q, orderBy: "createdTime", pageSize: 10, fields: "files(id)" }));
  if (found.status !== 200) throw kino.error("unavailable", "folder list status " + found.status);
  const existing = ((found.json() || {}).files || [])[0];
  if (existing) return existing.id;
  const made = await drive("POST", DRIVE + "/drive/v3/files?" + form({ fields: "id" }), {
    headers: { "Content-Type": "application/json; charset=UTF-8" },
    body: JSON.stringify({ name: FOLDER_NAME, mimeType: "application/vnd.google-apps.folder" }),
  });
  if (made.status !== 200) throw kino.error("unavailable", "folder create status " + made.status);
  return made.json().id;
}

// --- Base64 and the multipart body ---

/** Text as UTF-8 bytes in a "binary string" (one char per byte), what btoa encodes. */
function utf8Binary(text) {
  const bytes = new TextEncoder().encode(text);
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

/**
 * The Drive multipart/related body (metadata JSON, then the file) as base64, built without decoding the blob: kino.fetch
 * sends a `{ base64 }` body's bytes as they are, so the framing is spliced around the blob's own base64. The text before
 * the file is made a multiple of 3 bytes long (by the boundary's length) so its base64 ends cleanly and the blob's base64
 * follows as is; only the blob's last 4 characters are decoded, joined to the closing boundary and encoded again.
 */
function multipartRelated(metadataJson, blob) {
  const seed = kino.crypto.randomBytes(12, "hex");
  for (let pad = 0; pad < 3; pad++) {
    const boundary = "KinoSync" + seed + "x".repeat(pad);
    const head = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadataJson}\r\n--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`;
    const headBin = utf8Binary(head);
    if (headBin.length % 3 !== 0) continue;
    const tail = atob(blob.slice(-4)) + `\r\n--${boundary}--\r\n`;
    return { contentType: `multipart/related; boundary=${boundary}`, base64: btoa(headBin) + blob.slice(0, -4) + btoa(tail) };
  }
  // The boundary is counted twice in the head, so the three lengths cover every remainder: one always fits.
  throw kino.error("unavailable", "multipart framing did not align");
}

// --- Sync ---

/** The stored blob and its version, or null when Drive holds nothing yet. */
export async function syncPull() {
  const f = await findFile();
  if (isEmpty(f)) return null;
  const r = await drive("GET", DRIVE + "/drive/v3/files/" + encodeURIComponent(f.id) + "?alt=media");
  if (r.status === 404) return null;
  if (r.status !== 200) throw kino.error("unavailable", "download status " + r.status);
  // The version read BEFORE the download: if the file changed meanwhile, the next push sees an older version and conflicts (safe).
  return { blob: r.base64(), version: String(f.version) };
}

/** Writes the blob if Drive still holds [expectedVersion] (null = nothing); a changed version is Kino's "conflict". */
export async function syncPush({ blob, expectedVersion, maxBlobBytes }) {
  if (typeof blob !== "string" || !blob) throw kino.error("invalid_request", "no blob");
  if (maxBlobBytes && Math.floor((blob.length * 3) / 4) > maxBlobBytes + 2) throw kino.error("invalid_request", "blob over maxBlobBytes");
  const expected = expectedVersion == null || expectedVersion === "" ? null : String(expectedVersion);
  const f = await findFile();
  if (f && !isEmpty(f) && String(f.version) !== expected) throw kino.error("conflict", "the stored copy changed (version " + f.version + ")");
  if (!f && expected !== null) throw kino.error("conflict", "the stored copy is gone");
  const tag = kino.crypto.randomBytes(8, "hex");
  const metadata = f ? { appProperties: { w: tag } } : { name: FILE_NAME, parents: [await ensureFolder()], appProperties: { w: tag } };
  const body = multipartRelated(JSON.stringify(metadata), blob);
  const url = (f ? DRIVE + "/upload/drive/v3/files/" + encodeURIComponent(f.id) : DRIVE + "/upload/drive/v3/files") + "?" + form({ uploadType: "multipart", fields: "id,version" });
  const r = await drive(f ? "PATCH" : "POST", url, { headers: { "Content-Type": body.contentType }, body: { base64: body.base64 } });
  if (r.status === 413) throw fail("unavailable", "413", t("La copia es demasiado grande para Google Drive.", "The copy is too large for Google Drive."));
  if (r.status !== 200) throw kino.error("unavailable", "upload status " + r.status);
  const saved = r.json();
  // Read the tag back: not ours means another device wrote after us.
  const back = await drive("GET", DRIVE + "/drive/v3/files/" + encodeURIComponent(saved.id) + "?" + form({ fields: "id,version,appProperties" }));
  if (back.status !== 200) throw kino.error("unavailable", "verify status " + back.status);
  const check = back.json();
  if (!check.appProperties || check.appProperties.w !== tag) throw kino.error("conflict", "another device wrote right after");
  return { version: String(check.version) };
}

/** Ready when this device is connected and Drive answers. */
export async function syncStatus() {
  try {
    const f = await findFile();
    return { ready: true, message: isEmpty(f) ? t("Conectado. Drive aún no guarda nada.", "Connected. Drive stores nothing yet.") : t("Conectado a Google Drive.", "Connected to Google Drive.") };
  } catch (e) {
    return { ready: false, message: (e && e.say) || t("No se pudo consultar Google Drive.", "Could not ask Google Drive.") };
  }
}

// --- The settings form (Conectar) ---

export async function settingsStatus() {
  if (!String(kino.config.get("clientId") || "").trim() || !String(kino.config.get("clientSecret") || "").trim()) {
    return { status: t("Falta el cliente de Google (en Avanzado).", "The Google client is missing (under Advanced).") };
  }
  if (!String(kino.config.get("refreshToken") || "").trim()) {
    const dev = readStore("dev");
    if (dev && Date.now() < Number(dev.exp)) return { status: t(`Escribe ${dev.user} en ${displayUrl(dev.url)} y toca Ya lo hice.`, `Type ${dev.user} at ${displayUrl(dev.url)} and tap I did it.`) };
    return { status: t("Toca Conectar con Google.", "Tap Connect with Google.") };
  }
  return { status: (await syncStatus()).message };
}

const displayUrl = (u) => String(u || DEFAULT_VERIFY).replace(/^https?:\/\//, "");

async function connect() {
  const { id } = client();
  const r = await oauthPost("/device/code", { client_id: id, scope: SCOPE });
  if (r.status !== 200 || !r.json.device_code || !r.json.user_code) {
    if (r.json.error === "invalid_client" || r.json.error === "unauthorized_client") {
      return { message: t("Google no reconoce el cliente. Revisa el id del cliente en Avanzado.", "Google does not recognise the client. Check the client id under Advanced.") };
    }
    return { message: t("Google no dio un código. Intenta de nuevo en un momento.", "Google did not give a code. Try again in a moment.") };
  }
  const url = r.json.verification_url || r.json.verification_uri || DEFAULT_VERIFY;
  writeStore("dev", { code: r.json.device_code, user: r.json.user_code, url, interval: Number(r.json.interval) || 5, exp: Date.now() + (Number(r.json.expires_in) || 1800) * 1000 });
  return { message: t(`Abre ${displayUrl(url)} en tu celular o computador y escribe el código ${r.json.user_code}. Luego toca "Ya lo hice".`, `Open ${displayUrl(url)} on your phone or computer and type the code ${r.json.user_code}. Then tap "I did it".`) };
}

async function finish() {
  const dev = readStore("dev");
  if (!dev) return { message: t("Toca primero Conectar con Google.", "Tap Connect with Google first.") };
  if (Date.now() > Number(dev.exp)) {
    writeStore("dev", null);
    return { message: t("El código caducó. Toca Conectar con Google para pedir otro.", "The code expired. Tap Connect with Google to get another.") };
  }
  const { id, secret } = client();
  const r = await oauthPost("/token", { client_id: id, client_secret: secret, device_code: dev.code, grant_type: "urn:ietf:params:oauth:grant-type:device_code" });
  if (r.status === 200 && r.json.refresh_token) {
    if (r.json.scope && !String(r.json.scope).split(" ").includes(SCOPE)) {
      writeStore("dev", null);
      return { message: t("No diste el permiso para guardar archivos de Kino en Drive. Conecta de nuevo y déjalo marcado.", "You did not give the permission to keep Kino's files in Drive. Connect again and leave it ticked.") };
    }
    writeStore("dev", null);
    if (r.json.access_token) writeStore("tok", { token: r.json.access_token, exp: Date.now() + (Number(r.json.expires_in) || 3600) * 1000 });
    return { message: t("Conectado a Google Drive.", "Connected to Google Drive."), setSettings: { refreshToken: r.json.refresh_token } };
  }
  switch (r.json.error) {
    case "authorization_pending":
      return { message: t(`Google todavía espera el código. Escribe ${dev.user} en ${displayUrl(dev.url)} y vuelve a tocar Ya lo hice.`, `Google is still waiting for the code. Type ${dev.user} at ${displayUrl(dev.url)} and tap I did it again.`) };
    case "slow_down":
      return { message: t("Espera unos segundos y vuelve a tocar Ya lo hice.", "Wait a few seconds and tap I did it again.") };
    case "access_denied":
      writeStore("dev", null);
      return { message: t("Dijiste que no en Google. Toca Conectar con Google si quieres intentarlo otra vez.", "You said no at Google. Tap Connect with Google to try again.") };
    case "expired_token":
      writeStore("dev", null);
      return { message: t("El código caducó. Toca Conectar con Google para pedir otro.", "The code expired. Tap Connect with Google to get another.") };
    default:
      return { message: t("Google no aceptó el código. Toca Conectar con Google para empezar de nuevo.", "Google did not accept the code. Tap Connect with Google to start over.") };
  }
}

/**
 * This device forgets its connection; it does NOT revoke the token at Google. Measured against the real Google (2026-10-31):
 * revoking one device's refresh token invalidated the other device's too (its own revoke answered 400), so revoking here
 * would disconnect all of the person's devices. Removing the access everywhere is done in the Google account page.
 */
async function disconnect() {
  writeStore("tok", null);
  writeStore("dev", null);
  return {
    message: t("Este aparato ya no está conectado a Google Drive. Para quitar el acceso de todos tus aparatos entra a myaccount.google.com/permissions.", "This device is no longer connected to Google Drive. To remove access for all your devices go to myaccount.google.com/permissions."),
    setSettings: { refreshToken: "" },
  };
}

export async function action(key) {
  try {
    if (key === "connect") return await connect();
    if (key === "finish") return await finish();
    if (key === "disconnect") return await disconnect();
    return { message: t("Nada que hacer.", "Nothing to do.") };
  } catch (e) {
    return { message: (e && e.say) || t("No se pudo completar. Intenta de nuevo.", "Could not finish. Try again.") };
  }
}

export async function validateSettings(values) {
  const out = {};
  const id = String(values.clientId || "").trim();
  if (id && !/^\d+-[a-z0-9]+\.apps\.googleusercontent\.com$/i.test(id)) out.clientId = t("Ese id no parece de Google: termina en .apps.googleusercontent.com", "That id does not look like Google's: it ends in .apps.googleusercontent.com");
  const secret = String(values.clientSecret || "").trim();
  if (secret && secret.length < 10) out.clientSecret = t("Ese secreto es muy corto: cópialo completo.", "That secret is too short: copy all of it.");
  return Object.keys(out).length ? out : null;
}
