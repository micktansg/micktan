// Single endpoint for the corporateladder team game.
// POST /api/ladder?action=<verb>  — body varies per action:
//   create   {} → returns { teamId }
//   get      { teamId } → returns full team state
//   join     { teamId, handle, path } → adds member, returns team state
//   log      { teamId, handle, exerciseId, amount } → logs workout, returns team state
//   advance  { teamId } → advance to next boss if current is dead
//
// Falls back to in-memory state if Upstash env isn't set, so the artifact
// still demos locally without infra.

import type { APIRoute } from 'astro';
import { Redis } from '@upstash/redis';
import data from '../room/corporateladder/data.json';

export const prerender = false;

type Member = { handle: string; path: string; totalDamage: number; joinedAt: number; active?: boolean };
type LogEntry = {
  ts: number;
  handle: string;
  exerciseId: string;
  amount: number;
  damage: number;
  bossId: string;
  hitLine?: string;
  defeated?: boolean;
  bossName?: string;
};
type Team = {
  id: string;
  createdAt: number;
  currentBossIdx: number;
  currentBossHp: number;
  members: Member[];
  log: LogEntry[];
};

const env = (k: string): string | undefined =>
  ((import.meta as any).env?.[k] || (globalThis as any).process?.env?.[k]) as string | undefined;

const redisClient = (() => {
  const url = env('UPSTASH_REDIS_REST_URL');
  const token = env('UPSTASH_REDIS_REST_TOKEN');
  if (!url || !token) return null;
  return new Redis({ url, token });
})();

// Local fallback so /api/ladder still works in dev without Upstash.
const localStore: Map<string, Team> = (globalThis as any).__ladderLocal ||= new Map();

const teamKey = (id: string) => `ladder:team:${id}`;

const loadTeam = async (id: string): Promise<Team | null> => {
  if (redisClient) {
    const raw = await redisClient.get(teamKey(id));
    if (!raw) return null;
    return typeof raw === 'string' ? JSON.parse(raw) : (raw as Team);
  }
  return localStore.get(id) || null;
};

const saveTeam = async (team: Team): Promise<void> => {
  if (redisClient) {
    // 60-day expiry — abandoned teams clean themselves up
    await redisClient.set(teamKey(team.id), JSON.stringify(team), { ex: 60 * 60 * 24 * 60 });
    return;
  }
  localStore.set(team.id, team);
};

const newId = (): string => {
  // 8-char base36 random id
  return Math.random().toString(36).slice(2, 6) + Math.random().toString(36).slice(2, 6);
};

const sanitizeHandle = (s: string): string => {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code >= 32 && code !== 127) out += s[i];
  }
  return out.replace(/<[^>]*>/g, '').trim().slice(0, 24);
};

const validPath = (p: string): boolean => data.paths.some((x: any) => x.id === p);

const calcDamage = (
  exerciseId: string,
  amount: number,
  path: string,
  bossWeakness: string | null
): { damage: number; baseDamage: number; classMult: number; bossMult: number } => {
  const ex = data.exercises.find((e: any) => e.id === exerciseId);
  if (!ex) return { damage: 0, baseDamage: 0, classMult: 1, bossMult: 1 };
  const base = ex.damagePerUnit * amount;
  const pathDef = data.paths.find((p: any) => p.id === path);
  let classMult = 1;
  if (pathDef) {
    if ((pathDef as any).bonusType === 'all' && (pathDef as any).flatMultiplier) {
      classMult = (pathDef as any).flatMultiplier;
    } else if ((pathDef as any).bonusType === ex.type) {
      classMult = 1.5;
    }
  }
  const bossMult = bossWeakness && bossWeakness === path ? 1.5 : 1;
  const damage = Math.round(base * classMult * bossMult);
  return { damage, baseDamage: base, classMult, bossMult };
};

// Solo baselines in data.bosses[].hp scale by active team size at fight start.
// Mid-fight team-size changes scale REMAINING hp proportionally.
const activeCount = (team: Team): number =>
  team.members.filter(m => m.active !== false).length || 1;

const newTeam = (): Team => {
  const id = newId();
  // Boss starts scaled to 1 (no members yet); first member's join scales it up.
  const firstBossHp = (data.bosses as any[])[0].hp;
  return {
    id,
    createdAt: Date.now(),
    currentBossIdx: 0,
    currentBossHp: firstBossHp,
    members: [],
    log: [],
  };
};

// Scale current boss HP when active team size changes from oldN to newN.
// Preserves "damage already dealt" by only rescaling the REMAINING share.
const rescaleHpForSizeChange = (team: Team, oldN: number, newN: number) => {
  if (oldN <= 0 || newN <= 0 || oldN === newN) return;
  const boss = (data.bosses as any[])[team.currentBossIdx];
  if (!boss) return;
  const baseHp = boss.hp;
  // Total HP for this fight = baseHp × max(N, 1) at the time of scaling.
  // Damage already dealt = (baseHp × oldN) - currentHp.
  // After scaling: new currentHp = (baseHp × newN) - dmgDealt … but only if positive.
  // Simpler: scale REMAINING portion by newN/oldN. (Equivalent.)
  const ratio = newN / oldN;
  team.currentBossHp = Math.max(0, Math.round(team.currentBossHp * ratio));
};

const json = (obj: any, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

export const POST: APIRoute = async ({ request, url }) => {
  const action = url.searchParams.get('action') || '';
  let body: any = {};
  try { body = await request.json(); } catch { /* allow empty */ }

  // CREATE
  if (action === 'create') {
    const t = newTeam();
    await saveTeam(t);
    return json({ teamId: t.id, team: t });
  }

  // Backfill: any legacy member without `active` is treated as active.
  const ensureActiveFlag = (team: Team) => {
    for (const m of team.members) {
      if (m.active === undefined) m.active = true;
    }
  };

  // All other actions need a teamId
  const teamId = String(body?.teamId || '').trim();
  if (!teamId || teamId.length > 32) return json({ error: 'invalid teamId' }, 400);
  const team = await loadTeam(teamId);
  if (!team) return json({ error: 'team not found' }, 404);
  ensureActiveFlag(team);

  // GET
  if (action === 'get') {
    return json({ team });
  }

  // JOIN
  if (action === 'join') {
    const handle = sanitizeHandle(String(body?.handle || ''));
    const path = String(body?.path || '').trim();
    if (!handle || handle.length < 1) return json({ error: 'handle required' }, 400);
    if (!validPath(path)) return json({ error: 'invalid path' }, 400);
    const existing = team.members.find((m) => m.handle === handle);
    const oldN = activeCount(team);
    if (existing) {
      // Re-joining: allow path change. Reactivate if previously stepped out.
      existing.path = path;
      existing.active = true;
    } else {
      if (team.members.length >= 12) return json({ error: 'team full (12)' }, 400);
      team.members.push({ handle, path, totalDamage: 0, joinedAt: Date.now(), active: true });
    }
    const newN = activeCount(team);
    if (oldN === 0 && newN > 0) {
      // First active member: HP scales to newN from a previous "0" → use baseHp × newN.
      const boss = (data.bosses as any[])[team.currentBossIdx];
      if (boss) team.currentBossHp = boss.hp * newN;
    } else {
      rescaleHpForSizeChange(team, oldN, newN);
    }
    await saveTeam(team);
    return json({ team });
  }

  // STEP_OUT — soft pause. Toggle active flag; rescale HP.
  if (action === 'step_out' || action === 'step_in') {
    const handle = sanitizeHandle(String(body?.handle || ''));
    const member = team.members.find(m => m.handle === handle);
    if (!member) return json({ error: 'not a team member' }, 400);
    const oldN = activeCount(team);
    member.active = action === 'step_in';
    const newN = activeCount(team);
    rescaleHpForSizeChange(team, oldN, newN);
    await saveTeam(team);
    return json({ team });
  }

  // LOG
  if (action === 'log') {
    const handle = sanitizeHandle(String(body?.handle || ''));
    const exerciseId = String(body?.exerciseId || '').trim();
    const amountRaw = Number(body?.amount);
    if (!Number.isFinite(amountRaw) || amountRaw <= 0) return json({ error: 'invalid amount' }, 400);
    const amount = Math.min(Math.floor(amountRaw), 1000);
    const member = team.members.find((m) => m.handle === handle);
    if (!member) return json({ error: 'not a team member' }, 400);
    if (member.active === false) return json({ error: 'you are stepped out — step back in to log' }, 400);
    const ex = (data.exercises as any[]).find((e) => e.id === exerciseId);
    if (!ex) return json({ error: 'unknown exercise' }, 400);
    const boss = (data.bosses as any[])[team.currentBossIdx];
    if (!boss) return json({ error: 'no active boss' }, 400);
    const calc = calcDamage(exerciseId, amount, member.path, boss.weakness);
    const dealt = Math.min(calc.damage, team.currentBossHp);
    team.currentBossHp -= dealt;
    member.totalDamage += dealt;
    const hitLine = boss.hits[Math.floor(Math.random() * boss.hits.length)];
    let defeated = false;
    let advancedBoss: any = null;
    if (team.currentBossHp <= 0) {
      defeated = true;
      // auto-advance to next boss if any
      if (team.currentBossIdx + 1 < (data.bosses as any[]).length) {
        team.currentBossIdx += 1;
        const nextBoss = (data.bosses as any[])[team.currentBossIdx];
        team.currentBossHp = nextBoss.hp * Math.max(1, activeCount(team));
        advancedBoss = nextBoss;
      } else {
        team.currentBossHp = 0;
      }
    }
    team.log.unshift({
      ts: Date.now(),
      handle,
      exerciseId,
      amount,
      damage: dealt,
      bossId: boss.id,
      bossName: boss.name,
      hitLine,
      defeated,
    });
    if (team.log.length > 100) team.log = team.log.slice(0, 100);
    await saveTeam(team);
    return json({ team, dealt, calc, hitLine, defeated, advancedBoss });
  }

  // ADVANCE (manual nudge if needed)
  if (action === 'advance') {
    if (team.currentBossHp > 0) return json({ error: 'current boss still alive' }, 400);
    if (team.currentBossIdx + 1 >= (data.bosses as any[]).length) return json({ error: 'top of ladder' }, 400);
    team.currentBossIdx += 1;
    team.currentBossHp = (data.bosses as any[])[team.currentBossIdx].hp * Math.max(1, activeCount(team));
    await saveTeam(team);
    return json({ team });
  }

  return json({ error: 'unknown action' }, 400);
};
