/**
 * team.mjs — named team members with roles, replacing the single shared ADMIN_KEY
 * for day-to-day use.
 *
 *   Each member holds their own random key. Only its SHA-256 hash is stored, the
 *   same way client tokens work — the raw key exists solely in what you hand the
 *   person, so a leaked members file discloses nothing usable.
 *
 *   Roles are ordered: owner > admin > editor. A guard asking for 'admin' is
 *   satisfied by an owner too (see `atLeast`).
 *
 *   Records live at `team/members.json` through the shared store, so they land in
 *   MongoDB when it is connected and survive a redeploy. Both the mirror in
 *   server.mjs and hydrateToFs() in store.mjs must cover the `team/` prefix for
 *   that to hold — see MIRRORED_PREFIXES there.
 */
import { randomBytes, createHash } from 'node:crypto';
import { store } from './store.mjs';

export const MEMBERS_KEY = 'team/members.json';
export const ROLES = ['editor', 'admin', 'owner'];      // ascending privilege

const sha256 = (s) => createHash('sha256').update(String(s)).digest('hex');
const rank = (role) => ROLES.indexOf(role);

/** Does `role` satisfy a guard requiring `needed`? owner ≥ admin ≥ editor. */
export function atLeast(role, needed) {
  const a = rank(role), b = rank(needed);
  return a >= 0 && b >= 0 && a >= b;
}

export async function listMembers() {
  const arr = await store.getJSON(MEMBERS_KEY);
  return Array.isArray(arr) ? arr : [];
}

async function saveMembers(arr) {
  await store.putJSON(MEMBERS_KEY, arr);
  return arr;
}

/** Public shape — never includes keyHash. Safe to return from the API. */
export const publicMember = (m) => ({
  id: m.id, name: m.name, email: m.email || null, role: m.role,
  createdAt: m.createdAt, lastSeenAt: m.lastSeenAt || null, revokedAt: m.revokedAt || null,
});

/**
 * Create a member and issue their key. The raw key is returned exactly once —
 * it is not recoverable afterwards, only rotatable.
 */
export async function addMember({ name, email, role }) {
  if (!name || !String(name).trim()) throw new Error('A name is required.');
  if (!ROLES.includes(role)) throw new Error(`Role must be one of: ${ROLES.join(', ')}.`);
  const members = await listMembers();
  const key = randomBytes(24).toString('base64url');
  const member = {
    id: 'm_' + randomBytes(6).toString('hex'),
    name: String(name).trim().slice(0, 80),
    email: email ? String(email).trim().slice(0, 160) : null,
    role,
    keyHash: sha256(key),
    createdAt: new Date().toISOString(),
    lastSeenAt: null,
    revokedAt: null,
  };
  members.push(member);
  await saveMembers(members);
  return { member: publicMember(member), key };
}

/** Issue a fresh key for an existing member, invalidating the previous one. */
export async function rotateKey(id) {
  const members = await listMembers();
  const m = members.find((x) => x.id === id);
  if (!m) throw new Error(`No member "${id}".`);
  const key = randomBytes(24).toString('base64url');
  m.keyHash = sha256(key);
  m.revokedAt = null;                                   // rotating restores a revoked member
  await saveMembers(members);
  return { member: publicMember(m), key };
}

/**
 * Revoke access without deleting the record — the audit log references member
 * ids, so removing the row outright would orphan its own history.
 */
export async function revokeMember(id) {
  const members = await listMembers();
  const m = members.find((x) => x.id === id);
  if (!m) throw new Error(`No member "${id}".`);
  m.revokedAt = new Date().toISOString();
  await saveMembers(members);
  return publicMember(m);
}

export async function setRole(id, role) {
  if (!ROLES.includes(role)) throw new Error(`Role must be one of: ${ROLES.join(', ')}.`);
  const members = await listMembers();
  const m = members.find((x) => x.id === id);
  if (!m) throw new Error(`No member "${id}".`);
  m.role = role;
  await saveMembers(members);
  return publicMember(m);
}

/**
 * Resolve a raw key to a live member, or null. Revoked members never match, so
 * revoking takes effect on the very next request.
 */
export async function memberByKey(key) {
  if (!key) return null;
  const hash = sha256(key);
  const members = await listMembers();
  const m = members.find((x) => x.keyHash === hash && !x.revokedAt);
  return m || null;
}

/** Best-effort activity stamp so dormant keys are visible. Never blocks a request. */
export async function touchMember(id) {
  try {
    const members = await listMembers();
    const m = members.find((x) => x.id === id);
    if (!m) return;
    const now = Date.now();
    // Only write when the stamp is meaningfully stale — this runs on every request.
    if (m.lastSeenAt && now - Date.parse(m.lastSeenAt) < 5 * 60 * 1000) return;
    m.lastSeenAt = new Date(now).toISOString();
    await saveMembers(members);
  } catch { /* a failed stamp must never break the request */ }
}
