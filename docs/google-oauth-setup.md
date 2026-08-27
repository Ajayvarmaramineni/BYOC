# Google Drive OAuth Setup

Everything you need to let BYOC read and write files in a user's Google Drive.

**Time:** about 10 minutes, once per Google Cloud project.

**You do not need Google verification.** BYOC uses the non-restricted `drive.file` scope, which grants access only to files your app created or that the user explicitly opened with it. Restricted scopes like full `drive` require a security assessment; `drive.file` does not. That is a deliberate design choice, and it is why this setup ends in ten minutes instead of six weeks.

The console UI is genuinely confusing in a few places. Each step below flags the exact spot where it goes wrong.

---

## 1. Create a project

[console.cloud.google.com](https://console.cloud.google.com) → project dropdown (top left) → **New Project**.

Name it anything (`byoc-dev` is fine). Wait for it to finish creating, then make sure it is the *selected* project before continuing.

## 2. Enable the Drive API

Search **"Google Drive API"** in the top bar → open it → **Enable**.

> ⚠️ **Easy to skip, and the failure is confusing.** Without this, OAuth succeeds and then every API call returns 403. If your token works but uploads fail, this is why.

## 3. Fill in Branding

**APIs & Services → OAuth consent screen** (newer consoles label this **Google Auth Platform → Branding**).

| Field | Value |
| :--- | :--- |
| App name | Anything, e.g. `BYOC-dev` |
| User support email | Your email |
| App logo | **Leave empty** |
| Application home page | **Leave empty** |
| Application privacy policy link | **Leave empty** |
| Application terms of service link | **Leave empty** |
| Authorized domains | **Leave empty** |
| **Developer contact information** | **Your email. Required.** |

Click **Save**.

> ⚠️ **Developer contact information sits at the very bottom of the page**, below all the optional fields. It is required, it is easy to miss, and until it is filled in the console shows *"Your app's OAuth configuration is incomplete"* and **silently refuses to save test users** on the next step. If step 4 appears to do nothing, come back here.

> ⚠️ **Do not upload a logo.** It does nothing for a private dev app and creates a verification obligation later.

> ⚠️ **Do not fill in the domain links.** Adding a home page or privacy policy URL makes Google require you to add and *verify ownership* of that domain under Authorized domains.

## 4. Add yourself as a test user

**Audience** in the left sidebar (older consoles: the *Test users* section of the consent screen).

Confirm **Publishing status** is `Testing`, then **+ Add users** → your email → **Add**.

**Verify it saved.** The counter above the table should change:

```
0 users (0 test, 0 other) / 100 user cap     ← did not save
1 user  (1 test, 0 other) / 100 user cap     ← saved
```

If the table still says *"No rows to display"*, go back to step 3.

> ⚠️ **This must be the account you actually sign in with.** If you are signed into several Google accounts, the console may be showing you the project as one account while the OAuth flow picks a different one. Check the console URL: `authuser=3` means you have at least four accounts in that browser. The account named on any "Access blocked" screen is the one that needs to be in this list.

> ⚠️ **The "User support email" from step 3 is not a test user.** Your address appearing there grants nothing. Only this list does.

> ⚠️ Changes can take a few minutes to propagate. If you are certain the list is right and still get 403, wait five minutes and retry in a private window.

**Do not click "Publish app".** Publishing an unverified app is what triggers the review process you are avoiding.

## 5. Create the OAuth client

**Credentials → Create Credentials → OAuth client ID.**

**Application type** decides your redirect handling:

| Type | Use when | Redirect URIs |
| :--- | :--- | :--- |
| **Desktop app** | CLI tools, scripts, local dev | `http://localhost` pre-authorized, nothing to register |
| **Web application** | A real web app | You must register each URI exactly, e.g. `https://myapp.com/api/auth/callback` |

Copy the **Client ID** and **Client secret**.

> ⚠️ Picking "Web application" for a local script gives you `redirect_uri_mismatch`. For local development, choose Desktop app.

---

## Using it

### Public clients (browser, mobile, CLI)

Use PKCE and **no client secret**. A secret shipped in a browser bundle or a binary is not a secret.

```ts
import { BYOC } from "@byoc/core";
import {
  GoogleDriveProvider,
  GoogleDriveScope,
  generateCodeVerifier,
  generateCodeChallenge,
  generateOAuthState
} from "@byoc/google-drive";

const codeVerifier = generateCodeVerifier(64);
const codeChallenge = await generateCodeChallenge(codeVerifier);
const state = generateOAuthState(32);
// Store codeVerifier and state in the user's session.

const gdrive = new GoogleDriveProvider({
  auth: {
    clientId: process.env.GOOGLE_CLIENT_ID!,
    redirectUri: "https://myapp.com/api/auth/callback",
    scopes: [GoogleDriveScope.FILE]
  },
  rootFolderName: "MyApplication"
});

const loginUrl = gdrive.oauth.getAuthorizationUrl({ state, codeChallenge });
// Redirect the user to loginUrl.
```

On the callback, **compare the returned `state` to the stored one before doing anything else.** Skipping that check leaves the flow open to CSRF.

```ts
await gdrive.oauth.exchangeCode({ code, codeVerifier });

const storage = new BYOC({ provider: gdrive });
await storage.connect();
await storage.writeText("notes/meeting.md", "# Q3 Strategy Notes");
```

### Python

```python
from byoc import AsyncBYOC
from byoc.providers.gdrive import (
    GoogleDriveProvider,
    generate_code_challenge,
    generate_code_verifier,
    generate_oauth_state,
)

verifier = generate_code_verifier(64)
state = generate_oauth_state(32)

provider = GoogleDriveProvider(
    client_id=os.environ["GOOGLE_CLIENT_ID"],
    redirect_uri="https://myapp.com/api/auth/callback",
    root_folder_name="MyApplication",
)

login_url = provider.oauth.get_authorization_url(
    state=state, code_challenge=generate_code_challenge(verifier)
)
# ...redirect, then on the callback (after verifying state):
await provider.oauth.exchange_code(code=code, code_verifier=verifier)

storage = AsyncBYOC(provider=provider)
async with storage:
    await storage.write_text("notes/meeting.md", "# Q3 Strategy Notes")
```

### Keeping the session alive

BYOC requests `access_type=offline` and `prompt=consent` by default, which is what makes Google return a **refresh token**. Without both, the session dies in an hour and cannot be renewed.

The default token storage is in-memory, so sessions are lost on restart. For a long-running service, persist them encrypted:

```python
from byoc.providers.gdrive import EncryptedFileTokenStorage

provider = GoogleDriveProvider(
    client_id=os.environ["GOOGLE_CLIENT_ID"],
    token_storage=EncryptedFileTokenStorage(
        "./.byoc-session.enc", os.environ["TOKEN_ENCRYPTION_KEY"]
    ),
)
```

A refresh token is a long-lived credential for the user's Drive. Store it encrypted, never in plaintext, and never in source control.

---

## Verify it works

```bash
export BYOC_GDRIVE_CLIENT_ID="...apps.googleusercontent.com"
export BYOC_GDRIVE_CLIENT_SECRET="..."

cd python
.venv/bin/python scripts/validate_gdrive_live.py
```

> On macOS and most Linux distros there is no bare `python` on PATH, only
> `python3`. Calling the venv's interpreter directly, as above, works regardless
> and avoids needing to activate anything first.

This runs the full flow against your real Drive: OAuth, refresh token, uploads, awkward filenames, a multi-chunk resumable upload, quota, and delete. It cleans up the files it creates.

---

## Troubleshooting

| What you see | Cause | Fix |
| :--- | :--- | :--- |
| `Access blocked: ... has not completed the Google verification process`<br>`Error 403: access_denied` | The signed-in account is not a test user | Add **that exact address** (step 4). Check which account the error page names. |
| Test users will not save; *"OAuth configuration is incomplete"* | Developer contact information is empty | Fill it at the bottom of Branding (step 3) |
| `redirect_uri_mismatch` | Client is "Web application", or the URI is not registered exactly | Use Desktop app for local dev, or register the exact URI |
| OAuth succeeds, then every call is 403 | Drive API not enabled | Enable it (step 2) |
| No `refresh_token` in the response | Missing `access_type=offline` or `prompt=consent` | BYOC sets both by default; do not override them |
| `invalid_grant` on refresh | Refresh token revoked, expired, or the app is still in Testing | Re-run the consent flow. Testing-status refresh tokens expire after 7 days. |
| Works for you, fails for a teammate | They are not a test user | Add them, up to the 100-user cap |
| `Address already in use` on the validation script | An earlier run is still holding the port | `lsof -nP -iTCP:8765 -sTCP:LISTEN` then `kill <PID>` |

> ⚠️ **The 7-day refresh token expiry is worth planning around.** While your app is in `Testing`, Google expires refresh tokens after seven days, so users must re-consent weekly. That is fine for development. For production you either publish the app (verification is still not required for `drive.file`, but the consent screen review applies) or accept weekly re-auth.

---

## What your users see

Because the app is unverified, testers get an **"Google hasn't verified this app"** interstitial and must click *Advanced → Go to (app name)*. That is expected in `Testing` status and is different from the hard `access_denied` block, which means they are not on the test-user list at all.
