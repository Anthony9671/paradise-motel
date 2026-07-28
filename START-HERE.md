# Get guests working — the reliable way (about 10 minutes, once)

Your problem, confirmed straight from Netlify: your last upload deployed
**only index.html — "No functions deployed."** That's why guests can't sign
in and why the password won't stick. Drag-and-drop keeps dropping the function.

Connecting GitHub makes Netlify run a real build that installs what the
function needs and deploys it every time. After this, updates are automatic
and this never breaks again.

---

## Step 1 — Put these files on GitHub

1. Go to https://github.com/new
2. Repository name: `paradise-motel`  →  Create repository
3. On the next page click **uploading an existing file**
4. Drag in ALL of these, keeping the folders:
   - `package.json`
   - `netlify.toml`
   - `public/` (with index.html inside)
   - `netlify/` (with functions/api.mjs inside)
5. Click **Commit changes**

The folder structure must stay intact. GitHub's upload keeps folders if you
drag the folders themselves.

---

## Step 2 — Connect Netlify to the repo

1. Go to https://app.netlify.com/projects/paradisemotel/configuration/deploys
2. Under **Continuous deployment** → **Link repository** (or "Link to a
   Git provider")
3. Choose GitHub, authorize, pick `paradise-motel`
4. Build settings will read from netlify.toml automatically. Click **Deploy**.

Watch the deploy log. This time it will say functions were bundled — not
"No functions deployed."

---

## Step 3 — Set the two variables (only once)

https://app.netlify.com/projects/paradisemotel/configuration/env

Add:
- `STAFF_PASSWORD` = `2018` (or anything you want)
- `SESSION_SECRET` = a long random string

I may have already set these earlier — if they're there, leave them.
Then **Deploys → Trigger deploy → Deploy site** once so they apply.

---

## Step 4 — Confirm it worked

Open https://paradisemotel.netlify.app , then open the browser console
(Option+Cmd+J) and paste:

```
fetch('/api',{method:'POST',headers:{'content-type':'application/json'},body:'{"action":"health"}'}).then(r=>r.json()).then(console.log)
```

You want to see: `functionRunning: true, storage: "working"`.

Then sign in as staff with your password, go to **Setup → Upload this
device's records** to push room 114 up, and guests can sign in.

---

## Why not keep dragging the folder?

Drag-and-drop uploads files as-is with no build step. Your function needs
one small library installed, and only a build installs it. Every drag-drop
attempt deployed the page without a working function — exactly what
Netlify's log showed. GitHub runs the build. That's the whole difference.
