# Claude CMS

**One dashboard to manage every website you build — and hand any of them to a client with just a password.** The client edits their own site by clicking or chatting in plain English; the AI never writes code, so they can't break the design. Every change is version-controlled and publishes straight to the site's live domain.

> Full product walkthrough: [`HANDOVER.md`](./HANDOVER.md)

---

## How it works (3 steps)

1. **Set up the CMS & connect your database.** Run the app and point it at MongoDB — where every site, version, password and form submission lives.
2. **Deploy it → your live dashboard.** Host this repo once; your dashboard becomes an always-on URL (your command center).
3. **Ingest a website & hand it off.** Paste the live URL of a site you've built → it's instantly editable. If it's a client's, set a password and send the link. They self-serve; it publishes to their domain.

---

## Quick start (local)

```bash
npm install
ADMIN_KEY=your-secret npm start
# → http://localhost:4321/admin/?key=your-secret   (your dashboard)
```

Then **➕ Add a website** (paste a live URL or HTML), open its editor, and — if it's a client's — set a password on its card.

## Configuration (`.env`)

| Variable | Purpose |
|---|---|
| `ADMIN_KEY` | Your master/owner key (defaults to `owner-dev` for local dev). |
| `MONGODB_URI` | MongoDB connection string. **If unset, the CMS runs on the local filesystem** (great for dev). Set it to make data central & portable. |
| `MONGODB_DB` | Database name (default `northline_cms`). |
| `PORT` | Server port (default `4321`). |

AI editing (optional) and Vercel deploy tokens are set **in the Agency Console UI**, not in `.env` — they're stored server-side and never returned.

---

## Architecture (two layers)

- **Layer 1 — the CMS app (this repo):** a Node/Express server = the admin dashboard + the in-browser editor + the API. Hosted once. Data persists to **MongoDB** (or the filesystem as a fallback).
- **Layer 2 — the client sites:** each is a static site on **Vercel** with its own domain. On publish, the CMS renders the site and pushes a production deployment to that project.

**The core safety principle:** the AI never emits HTML/CSS — only structured `set` operations against a frozen content model, and a deterministic **Guardian** validates every change. Structure can't break. (The Guardian is plain code — no AI, no API key, no cost.)

## Project structure

```
server.mjs            # the app: routes, multi-site/page model, persistence, deploy
lib/
  store.mjs           # storage layer — MongoDB or filesystem
  autotag.mjs         # ingest: tags a site's editable content, freezes structure
  render.mjs          # deterministic render of template + content
  guardian.mjs        # validates every change (injection/structure/sanitise)
  fields.mjs          # SEO + bounded style + link virtual fields
  agent.mjs           # AI planner (chat → safe changeset); optional
  deploy.mjs          # static release + Vercel deploy
  config.mjs          # AI/Vercel config (cms-config.json)
admin/index.html      # the Agency Console (owner dashboard)
editor/index.html     # the in-browser editor (owner + client)
editor/overview.html  # the system overview page
sites/<name>/         # per-site content, versions, pages (demo: rocket, northline)
```

## Security notes

- Client access is a per-site **password** (hashed); a login only ever opens its one site. The owner key sees everything.
- `.env`, `cms-config.json`, and per-site runtime files (passwords, form submissions, audit logs) are **gitignored** — never commit secrets.
- Always run behind HTTPS in production.

---

*Built with AI Automations by Jack.*
