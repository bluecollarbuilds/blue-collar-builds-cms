#!/usr/bin/env node
/**
 * team.mjs — manage team members from the command line.
 *
 *   Stands in for the Agency Console panel until that ships. Talks to the same
 *   store the server does, so run it wherever the CMS runs (same MONGODB_URI, or
 *   the same working directory on the filesystem backend).
 *
 *     node scripts/team.mjs list
 *     node scripts/team.mjs add "Dana Okafor" admin dana@example.com
 *     node scripts/team.mjs role m_1a2b3c editor
 *     node scripts/team.mjs rotate m_1a2b3c
 *     node scripts/team.mjs revoke m_1a2b3c
 *
 *   A newly issued key is printed once and never stored in recoverable form.
 */
import { initStore } from '../lib/store.mjs';
import { listMembers, addMember, rotateKey, revokeMember, setRole, publicMember, ROLES } from '../lib/team.mjs';

const [cmd, ...args] = process.argv.slice(2);

const usage = () => {
  console.log(`
Usage: node scripts/team.mjs <command>

  list                            show every member
  add <name> <role> [email]       create a member and print their key
  role <id> <role>                change a member's role
  rotate <id>                     issue a new key (invalidates the old one)
  revoke <id>                     disable a member's key immediately

  roles: ${ROLES.join(' | ')}   (owner > admin > editor)
`);
};

const fmt = (m) => {
  const state = m.revokedAt ? 'REVOKED' : 'active';
  const seen = m.lastSeenAt ? new Date(m.lastSeenAt).toISOString().slice(0, 16).replace('T', ' ') : 'never';
  return `  ${m.id}  ${String(m.role).padEnd(6)}  ${String(m.name).padEnd(22)}  ${String(state).padEnd(7)}  last seen ${seen}`;
};

const showKey = (member, key) => {
  console.log(`\n  ${member.name} — ${member.role}\n`);
  console.log(`  key:  ${key}\n`);
  console.log('  This is the only time the key is shown. Store it now.');
  console.log(`  They sign in at:  /admin/?key=${key}\n`);
};

const m = await initStore();
if (m.mode === 'filesystem') console.log('[store] filesystem — members are local to this machine only.');

try {
  switch (cmd) {
    case 'list': {
      const members = await listMembers();
      if (!members.length) { console.log('\n  No members yet. ADMIN_KEY still works as owner.\n'); break; }
      console.log('');
      members.map(publicMember).forEach((x) => console.log(fmt(x)));
      console.log('');
      break;
    }
    case 'add': {
      const [name, role, email] = args;
      if (!name || !role) { usage(); process.exit(1); }
      const r = await addMember({ name, role, email });
      showKey(r.member, r.key);
      break;
    }
    case 'role': {
      const [id, role] = args;
      if (!id || !role) { usage(); process.exit(1); }
      const x = await setRole(id, role);
      console.log(`\n  ${x.name} is now ${x.role}.\n`);
      break;
    }
    case 'rotate': {
      const [id] = args;
      if (!id) { usage(); process.exit(1); }
      const r = await rotateKey(id);
      console.log('\n  Previous key is now invalid.');
      showKey(r.member, r.key);
      break;
    }
    case 'revoke': {
      const [id] = args;
      if (!id) { usage(); process.exit(1); }
      const x = await revokeMember(id);
      console.log(`\n  ${x.name} revoked — their key stops working immediately.\n`);
      break;
    }
    default:
      usage();
      process.exit(cmd ? 1 : 0);
  }
} catch (e) {
  console.error(`\n  Error: ${e.message}\n`);
  process.exit(1);
}
process.exit(0);
