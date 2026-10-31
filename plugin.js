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

/**
 * The Google client Kino Sync connects with, so nobody has to paste one. The id is public (it travels in every Google URL); the
 * secret is a SEALED secret of the published plugin ("secrets" in its manifest, sealed for its repository with sdk/seal.mjs):
 * this code only ever holds a marker, and Kino puts the real value in only inside a kino.fetch request to a host the manifest
 * declares. It keeps the secret out of the repository and its history; it is obfuscation, not secrecy (Google itself says such a
 * client's secret is not confidential: it ships inside public apps). This example's manifest declares no secret, so there the two
 * settings under "Avanzado" are the client. Pasting an own client in them replaces the built-in one.
 */
const BUILT_IN_CLIENT_ID = "163300307334-ov839vh3mpo0t9mt1lsbnir7ih8nr09l.apps.googleusercontent.com";

/** The sealed client secret's marker, or "" when the manifest declares none (kino.secret throws for a name it does not know). */
function builtInSecret() {
  try { return String(kino.secret("googleClientSecret") || ""); } catch (_) { return ""; }
}

function client() {
  const own = { id: String(kino.config.get("clientId") || "").trim(), secret: String(kino.config.get("clientSecret") || "").trim() };
  const ownGiven = Boolean(own.id || own.secret);
  const id = ownGiven ? own.id : BUILT_IN_CLIENT_ID;
  const secret = ownGiven ? own.secret : builtInSecret();
  if (!id || !secret) {
    throw fail("auth_required", "client missing", t("Falta el cliente de Google: pega el ID y el secreto (en Avanzado) y toca Guardar.", "The Google client is missing: paste the id and the secret (under Advanced) and tap Save."));
  }
  return { id, secret };
}

function hasClient() {
  try { client(); return true; } catch (_) { return false; }
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
  const url = DRIVE + "/drive/v3/files?" + form({ q, orderBy: "createdTime", pageSize: 10, fields: "files(id,version,size,modifiedTime,appProperties)" });
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
    return { status: t("Falta el cliente de Google: pega el ID y el secreto en el paso 1 y toca Guardar.", "The Google client is missing: paste the id and the secret in step 1 and tap Save.") };
  }
  if (!String(kino.config.get("refreshToken") || "").trim()) {
    const dev = readStore("dev");
    if (dev && Date.now() < Number(dev.exp)) return { status: t(`Escribe ${dev.user} en ${displayUrl(dev.url)} y toca Ya lo hice.`, `Type ${dev.user} at ${displayUrl(dev.url)} and tap I did it.`) };
    return { status: t("Toca Conectar con Google.", "Tap Connect with Google.") };
  }
  return { status: (await syncStatus()).message };
}

const displayUrl = (u) => String(u || DEFAULT_VERIFY).replace(/^https?:\/\//, "");

/**
 * Starts Google's device flow: the code the person types, or the reason it could not start. The device code (the credential only
 * this plugin and Google share) goes to storage, never into a screen's state.
 */
async function startDeviceFlow() {
  const { id } = client();
  const r = await oauthPost("/device/code", { client_id: id, scope: SCOPE });
  kino.log("connect: device/code answered " + r.status + (r.json.error ? " " + r.json.error : ""));
  if (r.status !== 200 || !r.json.device_code || !r.json.user_code) {
    return { error: r.json.error === "invalid_client" || r.json.error === "unauthorized_client" ? "client" : "failed" };
  }
  const dev = {
    code: r.json.device_code,
    user: r.json.user_code,
    url: r.json.verification_url || r.json.verification_uri || DEFAULT_VERIFY,
    interval: Number(r.json.interval) || 5,
    exp: Date.now() + (Number(r.json.expires_in) || 1800) * 1000,
  };
  writeStore("dev", dev);
  return { dev };
}

/**
 * One look at whether the person has accepted at Google. `status` is one of: none (no code was asked for), expired, approved (with the
 * refresh token), scope (accepted without the Drive permission), pending, slow (Google asks to ask less often), denied, error.
 */
async function pollDeviceFlow() {
  const dev = readStore("dev");
  if (!dev) return { status: "none" };
  if (Date.now() > Number(dev.exp)) {
    writeStore("dev", null);
    return { status: "expired" };
  }
  const { id, secret } = client();
  const r = await oauthPost("/token", { client_id: id, client_secret: secret, device_code: dev.code, grant_type: "urn:ietf:params:oauth:grant-type:device_code" });
  kino.log("finish: token answered " + r.status + (r.json.error ? " " + r.json.error : ""));
  if (r.status === 200 && r.json.refresh_token) {
    writeStore("dev", null);
    if (r.json.scope && !String(r.json.scope).split(" ").includes(SCOPE)) return { status: "scope" };
    if (r.json.access_token) writeStore("tok", { token: r.json.access_token, exp: Date.now() + (Number(r.json.expires_in) || 3600) * 1000 });
    return { status: "approved", refreshToken: r.json.refresh_token };
  }
  switch (r.json.error) {
    case "authorization_pending": return { status: "pending", dev };
    case "slow_down": return { status: "slow", dev };
    case "access_denied": writeStore("dev", null); return { status: "denied" };
    case "expired_token": writeStore("dev", null); return { status: "expired" };
    default: return { status: "error" };
  }
}

/** The classic settings form's "Conectar con Google" button. */
async function connect() {
  const started = await startDeviceFlow();
  if (started.error === "client") {
    return { message: t("Google no reconoce el cliente. Revisa el ID del cliente en Avanzado y toca Guardar.", "Google does not recognise the client. Check the client id under Advanced and tap Save.") };
  }
  if (started.error) return { message: t("Google no dio un código. Intenta de nuevo en un momento.", "Google did not give a code. Try again in a moment.") };
  const { dev } = started;
  return { message: t(`Abre ${displayUrl(dev.url)} en tu celular o computador y escribe el código ${dev.user}. Luego toca "Ya lo hice".`, `Open ${displayUrl(dev.url)} on your phone or computer and type the code ${dev.user}. Then tap "I did it".`) };
}

/** The classic settings form's "Ya lo hice" button. */
async function finish() {
  const dev = readStore("dev");
  if (!dev) return { message: t("Toca primero Conectar con Google.", "Tap Connect with Google first.") };
  const r = await pollDeviceFlow();
  switch (r.status) {
    case "approved":
      return { message: t("Conectado a Google Drive.", "Connected to Google Drive."), setSettings: { refreshToken: r.refreshToken } };
    case "scope":
      return { message: t("No diste el permiso para guardar archivos de Kino en Drive. Conecta de nuevo y déjalo marcado.", "You did not give the permission to keep Kino's files in Drive. Connect again and leave it ticked.") };
    case "pending":
      return { message: t(`Google todavía espera el código. Escribe ${dev.user} en ${displayUrl(dev.url)} y vuelve a tocar Ya lo hice.`, `Google is still waiting for the code. Type ${dev.user} at ${displayUrl(dev.url)} and tap I did it again.`) };
    case "slow":
      return { message: t("Espera unos segundos y vuelve a tocar Ya lo hice.", "Wait a few seconds and tap I did it again.") };
    case "denied":
      return { message: t("Dijiste que no en Google. Toca Conectar con Google si quieres intentarlo otra vez.", "You said no at Google. Tap Connect with Google to try again.") };
    case "expired": case "none":
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
  // `refresh`: the form reads its status line again, so the code (or "Conectado") stays on screen after the toast is gone.
  kino.log("action: " + String(key));
  try {
    if (key === "connect") return { refresh: true, ...(await connect()) };
    if (key === "finish") return { refresh: true, ...(await finish()) };
    if (key === "disconnect") return { refresh: true, ...(await disconnect()) };
    return { message: t("Nada que hacer.", "Nothing to do.") };
  } catch (e) {
    return { refresh: true, message: (e && e.say) || t("No se pudo completar. Intenta de nuevo.", "Could not finish. Try again.") };
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

// --- The screen (apiVersion 14): Kino's own components -----------------------------------------------------------------
//
// A header card with the state as a badge, a banner when something went wrong (with its retry button), Kino's `steps` for the
// three steps (ask Google for a code, type it at google.com/device, done), the state of the copy in Drive once connected, an
// accordion of questions and, folded away, Kino's own settings form for an own Google client.
//
// While the code step is open a timer asks Google every few seconds whether the person accepted, so nobody has to tap "I did it";
// the answer of that timer writes the refresh token into the plugin's own `refreshToken` setting through `config` (a password
// that never leaves this device). The screen's state holds only what may be seen (the code to type, its expiry, a problem word,
// the size and time of the copy): the device code stays in storage and the token in the setting.

/** The steps, in order. */
export const STEPS = ["connect", "code", "done"];
/**
 * How often Kino ticks while the code is on screen. Google is asked only when ITS interval has passed since the last time, so in front it is
 * asked every `interval` seconds as it requires; but Kino pauses the ticks while the person is at google.com/device, and on coming back
 * the very next tick (a second later) finds the interval long past and asks at once: the answer is known within about a second.
 */
export const TICK_MS = 1000;
const VERIFY_URL = "https://www.google.com/device";

/** What went wrong, as a state word; the texts are the screen's, in both languages. `retry`: the banner offers to ask for a new code. */
const PROBLEMS = {
  missing: { es: "Falta el cliente de Google. Pégalo en «Avanzado», más abajo, y toca Guardar.", en: "The Google client is missing. Paste it under «Advanced», below, and tap Save.", retry: false },
  client: { es: "Google no reconoce el cliente de Kino Sync.", en: "Google does not recognise Kino Sync's client.", retry: true },
  failed: { es: "Google no dio un código. Intenta de nuevo en un momento.", en: "Google did not give a code. Try again in a moment.", retry: true },
  denied: { es: "Dijiste que no en Google. Puedes intentarlo otra vez.", en: "You said no at Google. You can try again.", retry: true },
  expired: { es: "El código caducó. Pide otro.", en: "The code expired. Ask for another one.", retry: true },
  scope: { es: "No diste el permiso para guardar archivos de Kino en tu Drive. Conecta de nuevo y déjalo marcado.", en: "You did not give the permission to keep Kino's files in your Drive. Connect again and leave it ticked.", retry: true },
  error: { es: "Google no aceptó el código. Empieza de nuevo.", en: "Google did not accept the code. Start over.", retry: true },
};

/** The flow state read from whatever Kino kept (anything odd becomes the first step). */
export function sanitizeFlow(raw) {
  const f = raw && typeof raw === "object" ? raw : {};
  const positive = (v, d) => (Number.isFinite(v) && v > 0 ? v : d);
  const info = f.info && typeof f.info === "object" ? f.info : {};
  const user = typeof f.user === "string" ? f.user.slice(0, 40) : "";
  return {
    // The code step without a code (a state that should not exist) is the first step: there is nothing to show or copy.
    step: STEPS.includes(f.step) && !(f.step === "code" && !user) ? f.step : "connect",
    user,
    url: typeof f.url === "string" && /^https:\/\/[A-Za-z0-9.-]+\/[\x21-\x7e]{0,100}$/.test(f.url) ? f.url : VERIFY_URL,
    exp: positive(f.exp, 0),
    interval: Math.min(60, Math.max(5, Math.round(positive(f.interval, 5)))),
    error: typeof f.error === "string" && PROBLEMS[f.error] ? f.error : "",
    status: typeof f.status === "string" ? f.status.slice(0, 200) : "",
    info: { size: positive(info.size, 0), modified: positive(info.modified, 0) },
    // When the copy's size and time were asked of Drive (0: not yet, the screen shows a line saying it is looking).
    infoAt: positive(f.infoAt, 0),
  };
}

/** Where each step is, seen from the current one. */
export function stateOf(step, current) {
  const i = STEPS.indexOf(step);
  const c = STEPS.indexOf(current);
  return i < c ? "done" : i === c ? "current" : "pending";
}

/** A size in the words a person reads. */
export function sizeText(bytes) {
  if (!(bytes > 0)) return "0 B";
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1048576) return Math.round(bytes / 1024) + " KB";
  return (bytes / 1048576).toFixed(1) + " MB";
}

const tile = (key, icon, title, titleEn, subtitle, subtitleEn, trailing) => ({
  type: "ListTile", key, leading: { type: "Icon", name: icon, color: "primary" }, title, titleEn, subtitle, subtitleEn, ...(trailing ? { trailing } : {}),
});

function connectStep(f) {
  return [
    tile("why1", "lock", "Cifrada en tu aparato", "Encrypted on your device", "Google solo guarda texto cifrado: la clave no sale de tus aparatos.", "Google only keeps ciphertext: the key never leaves your devices."),
    tile("why2", "list", "Una carpeta «Kino Sync»", "A «Kino Sync» folder", "En tu Drive. El plugin solo ve sus propios archivos.", "In your Drive. The plugin only sees its own files."),
    tile("why3", "sync", "Todos tus aparatos iguales", "All your devices the same", "Historial, biblioteca y ajustes se mantienen al día.", "History, library and settings stay up to date."),
    { type: "ElevatedButton", key: "start", icon: "sync", autofocus: true, labelText: "Conectar con Google", labelTextEn: "Connect with Google", onPressed: { event: "start", timeoutMs: 25000 } },
  ];
}

function codeStep(f, tv) {
  return [{
    type: "Card", key: "codeCard", variant: "outlined", gap: 12, children: [
      { type: "Text", text: "Tu código", textEn: "Your code", style: "caption", color: "muted" },
      { type: "Text", key: "code", text: f.user, style: "h1", bold: true, color: "primary" },
      { type: "Text", text: tv ? "En tu celular abre google.com/device, escribe este código, elige tu cuenta y acepta." : "Copia el código, abre google.com/device, pégalo, elige tu cuenta y acepta.", textEn: tv ? "On your phone open google.com/device, type this code, pick your account and accept." : "Copy the code, open google.com/device, paste it, pick your account and accept." },
      ...(tv
        // A TV has no browser worth using: a QR to scan with the phone, and the code to type there.
        ? [{ type: "QrImage", key: "qr", value: f.url, size: "large", labelText: "Escanéalo con tu celular", labelTextEn: "Scan it with your phone" }]
        : [{
          type: "Row", key: "buttons", gap: 8, wrap: true, children: [
            // First copy the code, then open Google: the person pastes it there.
            { type: "ElevatedButton", key: "copy", icon: "copy", autofocus: true, labelText: "Copiar código", labelTextEn: "Copy code", onPressed: { go: { copy: { text: f.user, label: "Código" } } } },
            { type: "ElevatedButton", key: "open", icon: "open_in_new", labelText: "Abrir google.com/device", labelTextEn: "Open google.com/device", onPressed: { go: { url: { href: f.url, title: "Google" } } } },
          ],
        }]),
      { type: "CircularProgressIndicator", key: "waiting", text: "Esperando a que aceptes en Google…", textEn: "Waiting for you to accept at Google…" },
      ...(f.exp > 0 ? [{ type: "Text", key: "expires", text: "El código caduca en", textEn: "The code expires in", time: f.exp, timeFormat: "countdown", style: "caption", color: "muted" }] : []),
    ],
  }, { type: "TextButton", key: "again", icon: "refresh", labelText: "Pedir otro código", labelTextEn: "Ask for another code", onPressed: { event: "start", timeoutMs: 25000 } }];
}

function doneStep(f) {
  const hasCopy = f.info.size > 0;
  const asking = f.infoAt === 0;
  return [
    {
      type: "Card", key: "stateCard", variant: "outlined", gap: 4, children: [
        tile("connected", "check", "Conectado a Google Drive", "Connected to Google Drive", "Este aparato sincroniza solo.", "This device syncs by itself.", { type: "Badge", text: "Activo", textEn: "Active", color: "primary" }),
        tile("copy", "upload", "Copia en tu Drive", "Copy in your Drive",
          asking ? "Consultando tu Drive…" : hasCopy ? sizeText(f.info.size) + " · carpeta «Kino Sync»" : "Aún no hay copia: se sube en cuanto sincronices.",
          asking ? "Looking in your Drive…" : hasCopy ? sizeText(f.info.size) + " · «Kino Sync» folder" : "No copy yet: it is uploaded as soon as you sync."),
        ...(f.info.modified > 0 ? [{ type: "Text", key: "last", text: "Última copia subida", textEn: "Last copy uploaded", time: f.info.modified, timeFormat: "relative", style: "caption", color: "muted" }] : []),
        ...(f.status ? [{ type: "Text", key: "status", text: f.status, style: "caption", color: "muted" }] : []),
      ],
    },
    {
      type: "Row", key: "buttons", gap: 8, wrap: true, children: [
        { type: "TextButton", key: "check", icon: "refresh", autofocus: true, labelText: "Probar conexión", labelTextEn: "Test the connection", onPressed: { event: "check", timeoutMs: 25000 } },
        { type: "TextButton", key: "disconnect", icon: "close", labelText: "Desconectar este aparato", labelTextEn: "Disconnect this device", onPressed: "askDisconnect" },
      ],
    },
  ];
}

const question = (key, es, en, bodyEs, bodyEn) => ({ key, title: es, titleEn: en, children: [{ type: "Text", text: bodyEs, textEn: bodyEn }] });

/** The screen: a pure view of the flow state (no network, no clock). */
export function view(raw, device, linked) {
  const f = sanitizeFlow(raw);
  const tv = device === "tv";
  const connectedNow = linked === true || f.step === "done";
  const titles = {
    connect: ["Conectar con Google", "Connect with Google", "Código pedido", "Code requested"],
    code: ["Escribe el código en Google", "Type the code at Google", "Cuenta aceptada", "Account accepted"],
    done: ["Listo", "Done", "", ""],
  };
  const items = STEPS.map((step) => ({
    key: step, title: titles[step][0], titleEn: titles[step][1], subtitle: titles[step][2], subtitleEn: titles[step][3],
    state: stateOf(step, f.step),
    ...(step === f.step ? { children: step === "connect" ? connectStep(f) : step === "code" ? codeStep(f, tv) : doneStep(f) } : {}),
  }));
  const problem = f.error ? PROBLEMS[f.error] : null;
  return {
    type: "SingleChildScrollView", key: "page",
    // While the code is on screen Kino asks every few seconds whether Google has the person's answer (never faster than Google's own interval).
    ...(f.step === "code" ? { every: { ms: TICK_MS, event: "poll" } } : {}),
    // Once connected, the copy's size and time are asked of Drive AFTER the first paint (never while the screen opens): one tick, then no timer.
    ...(f.step === "done" && f.infoAt === 0 ? { every: { ms: 1000, event: "loadInfo" } } : {}),
    children: [{
      type: "Column", padding: 16, gap: 12, children: [
        {
          type: "Card", key: "header", variant: "filled", children: [{
            type: "Row", gap: 12, crossAxisAlignment: "center", children: [
              { type: "Icon", name: "sync", color: "primary" },
              { type: "Column", weight: 1, gap: 4, children: [
                { type: "Text", text: "Kino Sync", style: "h3" },
                { type: "Text", text: "Tu copia cifrada, en tu propio Google Drive", textEn: "Your encrypted copy, in your own Google Drive", style: "caption", color: "muted" },
              ] },
              connectedNow ? { type: "Badge", key: "badge", text: "Conectado", textEn: "Connected", color: "primary" } : { type: "Badge", key: "badge", text: "Sin conectar", textEn: "Not connected", color: "muted" },
            ],
          }],
        },
        ...(problem ? [{
          type: "MaterialBanner", key: "problem", role: "error", text: problem.es, textEn: problem.en,
          ...(problem.retry ? { action: { label: "Reintentar", labelEn: "Try again", onTap: "start" } } : {}),
        }] : []),
        { type: "steps", key: "flow", onStepTap: "goBack", items },
        { type: "ExpansionTile", key: "faq", multiple: true, items: [
          question("q1", "¿Qué se guarda?", "What is kept?", "Una copia de tu historial, tu biblioteca y tus ajustes de Kino, en un solo archivo cifrado dentro de la carpeta «Kino Sync» de tu Drive.", "A copy of your Kino history, library and settings, in a single encrypted file inside the «Kino Sync» folder of your Drive."),
          question("q2", "¿Quién puede leerla?", "Who can read it?", "Solo tus aparatos: se cifra antes de subirse y la clave nunca llega a Google. El plugin ve únicamente los archivos que él mismo crea.", "Only your devices: it is encrypted before it is uploaded and the key never reaches Google. The plugin only sees the files it creates itself."),
          question("q3", "¿Y mis otros aparatos?", "And my other devices?", "Repite estos pasos en cada uno con la misma cuenta. La clave de cifrado se pasa de uno a otro con «Enviar configuración» y «Recibir configuración».", "Repeat these steps on each one with the same account. The encryption key goes from one to the other with «Send configuration» and «Receive configuration»."),
          question("q4", "¿Cómo la borro o quito el acceso?", "How do I delete it or remove access?", "Borra la carpeta «Kino Sync» de tu Drive. Para quitar el acceso de todos tus aparatos a la vez entra a myaccount.google.com/permissions.", "Delete the «Kino Sync» folder from your Drive. To remove access for all your devices at once go to myaccount.google.com/permissions."),
        ] },
        { type: "ExpansionTile", key: "advanced", items: [{
          key: "client", title: "Avanzado: tu propio cliente de Google", titleEn: "Advanced: your own Google client",
          children: [
            { type: "Text", text: "Déjalo vacío: Kino Sync ya trae el suyo. Solo si quieres usar tu propio cliente de Google, pega aquí su ID y su secreto y toca Guardar.", textEn: "Leave it empty: Kino Sync comes with its own. Only if you want to use your own Google client, paste its id and secret here and tap Save.", style: "caption", color: "muted" },
            { type: "settings", key: "clientForm", keys: ["clientId", "clientSecret"] },
          ],
        }] },
      ],
    }],
  };
}

const connected = () => String(kino.config.get("refreshToken") || "").trim() !== "";

/** The copy's size and time in Drive (zeros when there is none). */
async function driveInfo() {
  const f = await findFile();
  if (isEmpty(f)) return { size: 0, modified: 0 };
  return { size: Number(f.size) || 0, modified: Date.parse(f.modifiedTime) || 0 };
}

/** What each event does. Pure but for the plugin's storage and its calls to Google. */
export async function onEvent(name, arg, rawFlow) {
  const f = sanitizeFlow(rawFlow);
  const next = (patch) => ({ state: { flow: { ...f, error: "", ...patch } } });
  switch (name) {
    // The first call after the screen opens: where is this device?
    case "open": {
      kino.log("screen open: connected=" + connected());
      // No call to Google here: the screen must say "connected" at once (the numbers come with the loadInfo timer).
      if (connected()) return next({ step: "done" });
      const dev = readStore("dev");
      if (dev && Date.now() < Number(dev.exp)) return next({ step: "code", user: dev.user, url: dev.url, exp: dev.exp, interval: dev.interval });
      return next({ step: "connect" });
    }
    case "start": {
      let started;
      try { started = await startDeviceFlow(); } catch (e) { started = { error: e && e.code === "auth_required" ? "missing" : "failed" }; }
      if (started.error) return next({ step: "connect", error: started.error });
      const dev = started.dev;
      writeStore("poll", { at: Date.now() }); // Google is first asked one interval from now
      return next({ step: "code", user: dev.user, url: dev.url, exp: dev.exp, interval: dev.interval, status: "" });
    }
    // The timer: has the person accepted? Nothing to say while Google still waits.
    case "poll": {
      if (f.step !== "code") return null;
      const last = readStore("poll");
      if (last && Date.now() - Number(last.at) < f.interval * 1000) return null; // too soon for Google: the next tick asks
      writeStore("poll", { at: Date.now() });
      let r;
      try { r = await pollDeviceFlow(); } catch (_) { return null; }
      switch (r.status) {
        case "approved":
          return { config: { refreshToken: r.refreshToken }, state: { flow: { ...f, step: "done", error: "", status: "", info: { size: 0, modified: 0 }, infoAt: 0 } }, toast: "Conectado a Google Drive", toastEn: "Connected to Google Drive" };
        case "pending": return null;
        case "slow": return { state: { flow: { ...f, interval: Math.min(60, f.interval + 5) } } };
        case "denied": case "expired": case "scope": case "error": return next({ step: "connect", error: r.status });
        // No code kept: either nothing was asked or the person already accepted (a late second tick). The real connection decides.
        default: return connected() ? next({ step: "done" }) : next({ step: "connect" });
      }
    }
    // The copy's size and time, asked once after the first paint; a failure still ends the asking (Probar conexión says why).
    case "loadInfo": {
      if (f.step !== "done" || f.infoAt !== 0) return null;
      let info = f.info;
      try { info = await driveInfo(); } catch (_) { /* kept as it was */ }
      return { state: { flow: { ...f, info, infoAt: Date.now() } } };
    }
    case "goBack":
      if (f.step === "connect") return null;
      writeStore("dev", null);
      return next({ step: "connect" });
    case "check": {
      const s = await syncStatus();
      let info = f.info;
      try { info = await driveInfo(); } catch (_) { /* the status line already says what failed */ }
      return next({ step: f.step, status: s.message, info, infoAt: Date.now() });
    }
    case "askDisconnect":
      return { dialog: { title: "¿Desconectar este aparato?", titleEn: "Disconnect this device?", body: "Tu copia en Drive no se borra y tus otros aparatos siguen conectados.", bodyEn: "Your copy in Drive is not deleted and your other devices stay connected.", buttons: [{ label: "Desconectar", labelEn: "Disconnect", event: "disconnect", variant: "primary" }, { label: "Cancelar", labelEn: "Cancel", variant: "text" }] } };
    // This device forgets its connection; it never revokes at Google (see disconnect() above).
    case "disconnect":
      writeStore("tok", null);
      writeStore("dev", null);
      return { config: { refreshToken: null }, state: { flow: { ...f, step: "connect", error: "", status: "", user: "", exp: 0, info: { size: 0, modified: 0 }, infoAt: 0 } }, toast: "Este aparato ya no está conectado", toastEn: "This device is no longer connected" };
    default: return null;
  }
}

export async function screen({ state, device }) {
  const linked = connected();
  const kept = state && state.flow && typeof state.flow === "object" && Object.keys(state.flow).length > 0 ? state.flow : null;
  // Nothing kept yet (the first paint, before `open` answers): a connected device starts on the last step, never on "Conectar".
  return view(kept || (linked ? { step: "done" } : null), device, linked);
}

export async function screenEvent({ name, arg, state }) {
  return onEvent(name, arg, state && state.flow);
}
