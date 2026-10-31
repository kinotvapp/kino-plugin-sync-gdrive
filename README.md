# Kino Sync (experimental)

[Leer en español](README.es.md)

A **Kino sync provider** that keeps the encrypted copy in **the person's own Google Drive**: no server of yours, no spreadsheets to copy, no tokens to paste. The person taps **Connect with Google**, types a code at `google.com/device`, and that is it (the same step TV apps use).

It is an experiment. It is not part of Kino and it is not recommended. It is unofficial: not affiliated with Google.

```
your phone ─┐                                           ┌─ the person's Drive
            ├─ plugin ─ https ─▶ oauth2.googleapis.com  │   folder "Kino Sync":
your TV  ───┘                    www.googleapis.com ────┘    kino-sync.bin, encrypted
```

## What the person sees
They open **Kino Sync** among their plugins (a screen built with Kino's new interface, apiVersion 14) and follow three steps:
1. **Connect with Google** → the code appears big (for example `ABCD-EFGH`) with its countdown.
2. **Type the code at Google**: on a phone or the desktop one button opens `google.com/device` (Kino asks to confirm before opening it) and another copies the code; on a TV a QR is shown to scan with the phone. The screen **notices by itself** when you accept (it asks Google every few seconds while it is open): nothing more to tap.
3. **Done**: "Connected to Google Drive", with "Test the connection" and "Disconnect this device".

Around the steps the screen uses Kino's components: a **header card** with a badge ("Connected" / "Not connected"); a **banner** with a "Try again" button when something fails (expired code, you said no, unknown client…); in the last step, the **state of the copy in Drive** (its size and when it was uploaded, with a time Kino rewrites by itself); an **accordion of questions** (what is kept, who can read it, other devices, how to delete it); and, folded away, **Kino's own settings form** for whoever wants to use an own Google client. On a TV the first button takes the focus and the QR replaces the open and copy buttons.

Every device connects on its own; the copy is the same for all. The same steps exist as buttons in the plugin's settings ("Connect by hand"), just in case.

Kino makes the encryption key by itself (`generateKey`) and carries it between devices with **Send / Receive configuration**; **Google never gets it**, it only sees the encrypted file. (The desktop app does not have that feature yet: there the key would have to be entered by hand.)

## Where the copy lives
In a **"Kino Sync" folder in the person's Drive**, one file, `kino-sync.bin`. The permission is `drive.file`: the plugin only ever sees the files **it** created, never the rest of the Drive. (The hidden app folder, `drive.appdata`, would have been nicer, but Google refuses it in this kind of sign-in: see "Verified" below.)

**Disconnect** only makes *this device* forget its connection. It does not revoke the token at Google, because revoking one device's token also killed the other device's (measured), so a revoke would disconnect all of them. To remove the access everywhere the person goes to `myaccount.google.com/permissions`.

## What you do once (the Google client)
The plugin needs an "OAuth client" from a Google Cloud project of yours. It is free.
1. At <https://console.cloud.google.com> create a project and enable the **Google Drive API**.
2. **Branding**: app name exactly **`Kino Sync`** (it must match the name on the home page), the home page, privacy policy and terms links (see "Pages"), a logo, and the domain of those links as an authorized domain (verified in Google Search Console).
3. **Data access**: add only the **`.../auth/drive.file`** scope (non-sensitive: no scope verification).
4. **Publish the app to "In production".** Left in "Testing", refresh tokens expire after **7 days**.
5. **Clients → Create → OAuth client ID → type "TVs and Limited Input devices"**. It gives you an id and a secret.
6. The **published** plugin carries this client built in, so nobody pastes anything: the id is public and the secret is a **sealed secret** (Kino's own mechanism: sealed for this repository with `sdk/seal.mjs`, put in the manifest's `secrets`; `plugin.js` only ever holds a marker, and Kino swaps in the real value only inside a request to the declared Google host). Sealing is obfuscation, not secrecy, and keeps the secret out of the repository and its history. To use another client, seal its secret for your own repository, or paste it under Advanced, which replaces the built-in one.

## How it stores, and how it avoids overwriting
Drive cannot do "write only if the version is X". The plugin does **check, write, check again**:
1. It reads the file's version; if it is not the one Kino pulled, that is a `conflict`.
2. It uploads the file **and a random tag** (`appProperties.w`) in **one** multipart request.
3. It reads the tag back; if it is not its own, another device wrote in between: `conflict`, and Kino pulls, merges and pushes again.

A window of milliseconds remains in which two devices writing at once can lose a write for a moment; Kino brings it back on the next round because every device keeps its own data. With a real server (or R2) that window does not exist.

## Verified and not verified
**Verified against the real Google (2026-10-31)**, with the plugin's own code (the screen was tested with the Kino SDK's rules and the imitation, not on a device):
- The device flow gives a code with `drive.file` and **refuses `drive.appdata`** (`invalid_scope: Invalid device flow scope`).
- The token exchange, the "Kino Sync" folder and the file are created, and a pull returns **identical bytes** (100 KB and 3 MB).
- A push with an old version is refused (`conflict`); only one folder is ever made.
- A **second device with its own sign-in** sees the copy the first one pushed.
- Revoking one device's token invalidated the other's, so Disconnect never revokes.

**Not verified** (needs people, time or a real consent screen): what the consent screen looks like and whether Google asks to verify the brand; Drive API quotas with many users in one project; how long tokens last once the app is in production; the `authorization_pending` poll answer (only the approved path was run against Google); what Google answers when the person unticks the permission (the check is in the code and the tests, not seen live); the "Drive is full" answer.

## Pages
The home page, privacy policy and terms of service the consent screen links to are in `docs/`.

## Pages
[Home](https://apk.comparadorinternet.co/sync-gdrive/) · [Privacy](https://apk.comparadorinternet.co/sync-gdrive/privacy.html) · [Terms](https://apk.comparadorinternet.co/sync-gdrive/terms.html) (their source is in `docs/`).
