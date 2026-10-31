# Sync Google Drive (experimental)

[Leer en español](README.es.md)

A **Kino sync provider** that keeps the encrypted copy in **the person's own Google Drive**: no server of yours, no spreadsheets to copy, no tokens to paste. The person taps **Connect with Google**, types a code at `google.com/device`, and that is it (the same step TV apps use).

It is an experiment. It is not part of Kino and it is not recommended. **It is tested against an imitation of Google (a local imitation of Google), not against the real Google.**

```
your phone ─┐                                           ┌─ the person's Drive
            ├─ plugin ─ https ─▶ oauth2.googleapis.com  │   (the app's hidden folder:
your TV  ───┘                    www.googleapis.com ────┘    kino-sync.bin, encrypted)
```

## What the person sees
1. **Connect with Google** → the plugin shows a code (for example `ABCD-EFGH`).
2. On another screen they open `google.com/device`, type the code, pick their account and accept.
3. They come back and tap **I did it**. Every device connects on its own; the copy is the same for all.

Kino makes the encryption key by itself (`generateKey`) and carries it between devices with **Send / Receive configuration**; **Google never gets it**, it only sees the encrypted file. (The desktop app does not have that feature yet: there the key would have to be entered by hand.)

## What you do once (the Google client)
The plugin needs an "OAuth client" from a Google Cloud project of yours. It is free. Steps (from memory of Google's documentation; check them as you go):
1. At <https://console.cloud.google.com> create a project and enable the **Google Drive API**.
2. **OAuth consent screen**: *External*, set the app name and add the **`.../auth/drive.appdata`** scope (the only one; Google classes it as non-sensitive).
3. **Publish the app to "In production".** Left in "Testing", refresh tokens expire after **7 days** and everyone would have to reconnect weekly.
4. **Credentials → Create → OAuth client ID → type "TVs and Limited Input devices"**. It gives you an id and a secret.
5. Paste them into the plugin (Advanced) or, once proven, set them as defaults in `plugin.js`. This kind of secret is not truly secret (it ships inside public apps), but do not push it to a public repository without thinking.

## How it stores, and how it avoids overwriting
Drive cannot do "write only if the version is X". The plugin does **check, write, check again**:
1. It reads the file's version; if it is not the one Kino pulled, that is a `conflict`.
2. It uploads the file **and a random tag** (`appProperties.w`) in **one** multipart request.
3. It reads the tag back; if it is not its own, another device wrote in between: `conflict`, and Kino pulls, merges and pushes again.

A window of milliseconds remains in which two devices writing at once can lose a write for a moment; Kino brings it back on the next round because every device keeps its own data. With a real server (or R2) that window does not exist.

## What was and was not verified
**Verified** (local tests against the imitation): the code flow, the errors (wrong client, permission removed, code expired), upload and download with exact bytes, the conflict by version and by tag, the token refresh (once) and the revoked connection, that the encryption key and the secrets never travel to Drive, and that the manifest passes the validator and uses only two hosts.

**Not verified against the real Google** (needs a real client to try):
- That the `drive.appdata` scope is allowed in the device flow (I believe so; I could not confirm it).
- That a multipart `files.update` accepts the tag in `appProperties` and returns it unchanged.
- The consent screen: whether it says "unverified app", how many users it allows before asking for verification, and whether brand verification is needed.
- Real Drive API quotas for many users in one project.
- That `kino.fetch` handles the token endpoint's `428` answer correctly (the imitation returns it the way Google's documentation describes).

## Pages
[Home](https://apk.comparadorinternet.co/sync-gdrive/) · [Privacy](https://apk.comparadorinternet.co/sync-gdrive/privacy.html) · [Terms](https://apk.comparadorinternet.co/sync-gdrive/terms.html) (their source is in `docs/`).
