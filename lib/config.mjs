/**
 * config.mjs — runtime agency settings (set via the Agency Console, or env).
 * Stores the AI provider + API key so the owner can paste a key in the UI.
 * The raw key is stored server-side only; the API never returns it.
 *
 * Every setting also accepts an env-var fallback, so a host with no persistent
 * disk (where cms-config.json can't survive a redeploy) stays fully configured.
 * A value set in the Console always wins over the env var.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'cms-config.json');
let cfg = existsSync(PATH) ? JSON.parse(readFileSync(PATH, 'utf8')) : {};

/** Effective settings: Console values first, then env fallback. */
export function getConfig() {
  return {
    ...cfg,
    vercelToken: cfg.vercelToken || process.env.VERCEL_TOKEN || '',
    vercelTeam: cfg.vercelTeam || process.env.VERCEL_TEAM_ID || '',
    publicUrl: cfg.publicUrl || process.env.PUBLIC_URL || '',
  };
}
export function setConfig(patch) { cfg = { ...cfg, ...patch }; writeFileSync(PATH, JSON.stringify(cfg, null, 2)); return cfg; }

/** Effective AI credentials: UI config first, then env fallback. */
export function aiCreds() {
  const key = cfg.apiKey || process.env.OPENROUTER_API_KEY || process.env.ANTHROPIC_API_KEY || '';
  let provider = cfg.provider;
  if (!provider) provider = process.env.OPENROUTER_API_KEY ? 'openrouter' : process.env.ANTHROPIC_API_KEY ? 'anthropic' : (key.startsWith('sk-ant') ? 'anthropic' : 'openrouter');
  const model = cfg.model || (provider === 'anthropic' ? 'claude-sonnet-4-6' : 'anthropic/claude-sonnet-4.5');
  return { key, provider: key ? provider : 'local', model };
}
export function plannerMode() { return aiCreds().provider; }
