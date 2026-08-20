# Claude CMS — Handover & How-It-Works

> **For the presentation/video agent:** this document explains the product end-to-end. The most important section is **"How does it work — Step 1, 2, 3"** — that's the narrative spine of the video. Everything else is supporting detail you can pull from as needed.

---

## TL;DR (the one-liner)

**It's one dashboard where you keep every website you manage. You add a site you've already built, and if it belongs to a client you set a password and hand it over — then the client edits their own site by clicking or chatting, and it publishes straight to their live domain. You never touch their site again, and you see everything from one place.**

---

## The problem it solves

Agencies and freelancers build beautiful websites — but then the client wants to change a headline, swap an image, or update their hours, and they have to come back to the agency every time. That's friction for the client and unpaid busywork for the agency.

Existing fixes are bad: hand over WordPress (clients break the layout) or do the edits yourself forever (doesn't scale). **Claude CMS** gives the client a safe, dead-simple editor for *their content only* — they can never break the design — while the agency keeps full oversight from a single dashboard.

---

## The mental model: TWO layers (this is the key to understanding it)

**Layer 1 — The Claude CMS (your dashboard).** One app you host **once**. It's your command center — every website you manage lives inside it. Think `cms.youragency.com`.

**Layer 2 — The client websites.** Each is a separate live site on Vercel with its own domain (`acme.com`, `bobsplumbing.com`). The CMS doesn't *host* these — it *pushes updates to them*.

Keeping these two layers straight is the whole thing: **you set up the dashboard once; the websites get added into it.**

---

## How does it work — Step 1, 2, 3

### Step 1 — Set up your Claude CMS & connect your database *(one-time)*
You stand up the CMS app and **connect it to your database (MongoDB)**. This is the most important part of setup: the database is where every website, every version, every password and every form submission lives — so your dashboard isn't tied to any one machine and your data is safe and portable. Connect the database once and you never think about it again.

### Step 2 — Deploy it → your live dashboard *(one-time)*
The whole CMS lives in a single (private) code repository. You deploy it to a host, and now your dashboard is a real, always-on URL you log into from anywhere — e.g. `cms.youragency.com`. This is *your* command center. You only ever do Steps 1 and 2 once; every client from now on lives inside this one dashboard.

### Step 3 — Ingest a website (and hand it off)
This is the repeatable bit — you do it for every site you manage. You've built a website and already deployed it (it's live on Vercel with its own domain). In the dashboard you click **"Add a website"**, paste the live URL, and the CMS:
- fetches the site,
- automatically makes every piece of content editable (headings, text, buttons, images, links, SEO),
- and locks the layout/structure so it can't be broken.

The site now appears as a card in your dashboard. **If it belongs to a client, set a password on its card and send them the link + password** — no username, just a website and a password. They log in, edit *their own site* by clicking or chatting, hit Publish, and it deploys straight to their live domain. You're hands-off — but you see every change from your dashboard and can roll anything back.

**That is the entire process. It is not more complicated than that.**

---

## What the client experiences

1. Opens the link you sent → clean login screen → types the password.
2. Sees their own website with an "EDIT MODE" overlay.
3. Clicks any text/button/image to change it, **or** types a request like *"make the headline punchier"* into the chat.
4. Hits **Publish** → their live site updates in seconds.

No accounts to create, no usernames, no software to install, no way to see or touch any other client's site.

---

## Why the client can never break anything (the safety story)

This is the core selling point — lean into it.

- **The AI never writes code.** It can only fill in content slots against a frozen template. The layout and structure are literally unreachable.
- **The Guardian.** Every single change is validated by deterministic code before it's allowed — it blocks anything malformed or anything that would make a section disappear. *(Important: the Guardian is plain logic, not an AI model — it needs no API key and costs nothing.)*
- **Draft → Publish.** Nothing goes live until Publish. Saving keeps a private draft.
- **Optional approval gate.** Per site, you can require *your* sign-off before a client's change goes live — or let them publish themselves (it's all reversible anyway). Your choice, per client.
- **Version control + rollback.** Every publish is an immutable snapshot. One click restores any previous version. An activity log shows who changed what, when.
- **Password-scoped access.** A client's login only ever opens their one site — never your other clients.

---

## What you can actually edit

- **Click-to-edit** — hover anything, click, type. Text, headings, buttons, images, inline.
- **Edit by chat** — describe a change in plain English; the AI plans it, the Guardian checks it.
- **Sections** — click a block to select a whole section; fine-tune spacing, size and alignment with bounded sliders (they can't break the layout).
- **SEO** — a Yoast-style panel: live Google preview, a focus-keyphrase score with red/amber/green checks, plus auto-generated sitemap, robots.txt and structured data.
- **Pages** — add new pages (blank or article) that inherit the site's styling.
- **Images** — upload from the computer or paste a URL.
- **Form inbox** — submissions from the live site's forms land in the dashboard (leads stay with you).
- **Version history & activity log** — undo/redo, rollback, full audit trail.

---

## Under the hood (architecture)

- **The CMS app** — a Node.js application (the admin dashboard + the editor + the API). You host it once. This is Layer 1.
- **The database — MongoDB.** All content, versions, drafts, passwords, form submissions and the audit trail live in one MongoDB database. This is what makes the dashboard portable: the data isn't tied to one machine, so the CMS can run on any host.
- **The client sites — Vercel.** Each client site is a static deployment on your Vercel account, with its own domain. On Publish, the CMS renders the static site and pushes a new production deployment to that site's Vercel project — no Git, no rebuild. The domain updates in seconds.
- **AI — optional.** Only the "describe a change" chat uses an AI model (Anthropic or OpenRouter). Click-to-edit and the Guardian work with **zero** AI and zero cost.

---

## Roles

| | **You — the agency (owner)** | **The client** |
|---|---|---|
| Access | A master key; sees & controls everything | One password; their site only |
| Can | Add sites, edit anything, set passwords, toggle approval, connect hosting, read the activity log + form inbox | Edit their own content, publish (or submit for approval), read their own form submissions |
| Cannot | — | See or touch any other client's site |

---

## The one honest rule (worth saying on camera)

Once a website is added to the CMS, **the CMS becomes the source of truth for its content.** The client (and you) edit it through the dashboard from then on. You don't go back and push code changes to the original repo for that site — if you ever did a full redesign, you'd just re-add it. For the normal "hand it off, client maintains the content" workflow, this is a clean, one-way handoff.

---

## Why this is a business, not just a tool

- **Recurring revenue** — charge clients a monthly fee for their self-serve editor + hosting.
- **Hands-off** — once handed over, you do nothing; the client maintains their own content.
- **Scales** — one dashboard, unlimited client sites, no per-site overhead.
- **White-label** — it's your dashboard, your brand, your domain.

---

## Suggested video framing

**The hook / one-liner:**
> *"I host one dashboard. I drop in any website I've built, set a password, and send it to the client. From then on they edit their own site — by clicking or just chatting — and it publishes straight to their live domain. I never touch it again."*

**The demo beats:**
1. Show the dashboard with several client sites in it.
2. "Add a website" → paste a URL → it's instantly editable.
3. Open the editor → click a headline and retype it → type a chat command → watch it apply, checked by the Guardian.
4. Set a password on the site's card → show the client's clean login.
5. Log in as the client → make an edit → Publish → show the live domain update.
6. Back in the dashboard: the version history + activity log + the ability to roll back.

**The emotional payoff:** the client gets control without risk; the agency gets recurring revenue without the support tickets.

---

## Glossary (for clarity)

- **Cluster (MongoDB Atlas)** — your database server in the cloud. Holds your databases & collections.
- **Document database** — stores flexible JSON-like documents instead of rigid tables. Fits this app because every page/version is already a document.
- **Ingest** — the act of adding a website to the CMS: it fetches the site and makes the content editable.
- **The Guardian** — the deterministic safety layer that validates every change.
- **Draft / Publish** — a saved draft is private; publishing pushes it live.
- **Vercel project** — where a client's static site is hosted; its domain is attached here.
