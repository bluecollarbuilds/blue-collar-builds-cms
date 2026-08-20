# AI CMS — Product & Infrastructure Strategy

**One line:** An agency builds a client website, ingests it into the CMS, and hands the client a magic-link editor. The client self-updates their **live** site by clicking text or chatting — every change safety-validated and version-controlled. The agency never touches it again, and bills monthly.

---

## 1. Hosting model — DECISION: host-through-us

Three candidates were evaluated:

| Model | How edits reach the live site | Verdict |
|---|---|---|
| **A. Host-through-us** (CMS-hosted + custom domains) | We render a static bundle and serve it; client points their domain at us via CNAME | ✅ **PRIMARY** |
| B. Embed / runtime overlay | A `<script>` on the client's existing host patches the DOM at runtime | ⚠️ break-glass only (immovable DNS) |
| C. Push-to-git / rebuild | Publish commits to the client's repo; their CI redeploys | 🔧 "eject" option for dev-owned sites |

**Why A wins:** it's the only model that's *truly hands-off*. We own the whole publish→live path, so we can guarantee **atomic deploys, instant rollback, and content-in-the-HTML (SEO-safe)**. Our frozen-template + content-model is literally a static-site generator's input — host-through-us is the natural fit. B is disqualified as a primary because runtime-injected content isn't reliably crawlable, flashes/reflows, and dies if the client's host adds a CSP header. C reintroduces the agency (build failures, env vars) — the exact support burden we're killing.

We still offer **C as an "eject"** (export a standalone static site → `vercel deploy`) so clients never feel locked in — `Export static` already does this.

## 2. Publish → live pipeline

```
edit → Guardian → draft → PUBLISH
  → render static bundle (content inlined into frozen template)
  → STAGE   immutable release keyed by version  (sites/<name>/releases/<seq>/)
  → ACTIVATE atomic pointer flip                (releases/current.json)
  → live edge serves the active release          (/live/<name>)
```

- **Atomic:** the pointer only moves *after* the bundle is fully written. A failed export is a no-op — the old version keeps serving. The live site can never half-deploy or break.
- **Rollback = pointer flip.** Old releases stay on disk; undo/redo/jump just re-`activate` a prior version's release. **Versioning maps 1:1 to deploys.**
- **Custom domains (prod):** client adds a CNAME → our edge; TLS auto-provisioned via ACME; a `domains` table maps `hostname → site → current_release`.
- **SEO/perf:** content is server-rendered into the HTML at publish time — fully crawlable, no hydration, CDN-cacheable, sub-50ms TTFB.

## 3. Multi-tenancy, auth & handoff

**Roles:** Owner/Agency (manages all sites, ingests, configures, hands off) · Client-Editor (edits exactly ONE site, can publish + roll back, **can never touch code/layout**) · Viewer (optional).

**Client access = magic-link tokenized URL** (no passwords, no OAuth friction). A 256-bit token is generated at handoff; only its **SHA-256 hash** is stored; the raw token lives only in the link you send. Revoke = delete the hash. Re-issue = one click.

**Handoff flow (mostly automated):**
1. Build the site (your normal AI workflow)
2. **Ingest** → auto-detects every editable field + collection (zero per-site code)
3. **Configure** → name, custom domain, client name
4. **Generate client link** (one click → magic link)
5. **Send** it to the client
6. Client edits (click/chat) → **publishes** → live
7. Agency does nothing further — Guardian + versioning mean the client can't break it

**Production tenant schema (Supabase + RLS):**
```
orgs(id, name, plan)
sites(id, org_id, name, slug, custom_domain, template_ref, content_model jsonb, status)
members(id, org_id, user_id, email, role, site_id?)         -- client-editor pinned to one site_id
versions(id, site_id, snapshot jsonb, label, published, created_by, created_at)  -- append-only
edit_tokens(id, site_id, role, token_hash, expires_at, revoked_at)
audit_log(id, org_id, site_id, actor, action, diff jsonb, ip, ua, created_at)
```
Row-Level Security enforces isolation even if app code has a bug: a client session is scoped to a single `site_id`.

## 4. Security & robustness

- **The Guardian is the write-safety boundary.** Every write — click, chat, or AI planner — funnels through one deterministic validator: known field only, no `<script>`/event-handlers/`javascript:`, rich fields sanitised to an allow-list, **structural invariant re-render (every section + field must survive)**, blast-radius cap. The AI *proposes*; the Guardian *disposes*.
- **The frozen template** means edits only fill tagged slots — altering layout/DOM is structurally impossible, not just forbidden.
- **Hardening:** token hashes (never raw), HttpOnly/Secure cookies in prod, rate-limit the write + AI endpoints, per-site/day AI budget + plan-size cap (runaway protection), full **audit log** (who changed what), instant revoke.
- **Never-break guarantee:** serving is "read pointer → serve immutable file" — no runtime template execution on the hot path. If the control plane is down, the edge keeps serving the last release.

## 5. The business (for agencies in Jack's audience)

Sell **"a website your client can run themselves — forever, without you."**

| Line item | Price | Covers |
|---|---|---|
| One-time build | **$2,500–$5,000** | design, AI build, CMS ingest + setup |
| Monthly CMS + hosting | **$99–$299/mo** | hosting, self-serve editor, version backups, safety, support |

10 clients × $149/mo = **$17,880/yr recurring** on top of build fees. The pitch: *"You stop emailing me to change a price; I stop being your unpaid support desk."* Undo/version-history is the reassurance close for nervous non-technical owners. Positioning beats WordPress (no sysadmin), Webflow (no webmaster), Wix (no rebuild), and "come back to the agency" (no bottleneck).

**For Jack's channel:** ship the CMS itself and edit it live on camera ("I'm changing this site by talking to it"). Video → "Agency Handoff Kit" lead magnet → Skool upsell (template + CMS access + setup calls). The tool *is* the proof.

## 6. Production stack & migration path

| Layer | Local (today) | Production |
|---|---|---|
| CMS app + editor | Node/Express on :4321 | Vercel |
| Control plane (sites, versions, tokens, audit) | JSON files per site | Supabase Postgres + RLS |
| Release bundles | `releases/<seq>/` on disk | Supabase Storage / R2 |
| Live serving + custom domains + TLS | `/live/:name` Express | Cloudflare for SaaS (Worker resolves host→site→release) |
| Deploy seam | `LocalAdapter` (`stage`/`activate`/`rollback`) | `CloudflareAdapter` — same interface |
| Email magic links | link shown in console | Resend/Postmark |

The `DeployAdapter` interface is the single cutover seam — `activate()` is the only "go live" step, so swapping local → cloud changes nothing upstream.

## 7. Status — built & verified today

✅ Universal ingest (any framework) · ✅ click-to-edit + chat-to-edit · ✅ Guardian · ✅ add/remove sections · ✅ version control (undo/redo/jump) · ✅ **static-release deploy with atomic pointer** · ✅ **`/live/<name>` hosting** · ✅ **magic-link handoff + per-site auth gate** · ✅ **owner Agency Console** · ✅ **static export (eject)** · ✅ audit log.

Next: reorder/hide sections, custom-domain attach, the Supabase/Cloudflare adapters, Stripe billing for the retainer.
