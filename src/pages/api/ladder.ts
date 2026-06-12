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
const versionKey = (id: string) => `ladder:team:${id}:v`;
const TTL_SECONDS = 60 * 60 * 24 * 60; // 60-day expiry — abandoned teams clean themselves up

const loadTeam = async (id: string): Promise<{ team: Team; version: number } | null> => {
  if (redisClient) {
    const [raw, v] = await Promise.all([
      redisClient.get(teamKey(id)),
      redisClient.get(versionKey(id)),
    ]);
    if (!raw) return null;
    try {
      const team = typeof raw === 'string' ? JSON.parse(raw) : (raw as Team);
      return { team, version: Number(v) || 0 };
    } catch (err) {
      console.error('[ladder] corrupt team blob for', id, err);
      return null;
    }
  }
  const team = localStore.get(id);
  return team ? { team, version: 0 } : null;
};

// Unconditional write — used only for freshly created teams (no concurrent
// writer can exist before the id has been shared).
const saveTeam = async (team: Team): Promise<void> => {
  if (redisClient) {
    await redisClient.set(teamKey(team.id), JSON.stringify(team), { ex: TTL_SECONDS });
    await redisClient.set(versionKey(team.id), '1', { ex: TTL_SECONDS });
    return;
  }
  localStore.set(team.id, team);
};

// Compare-and-set write: succeeds only if nobody else saved since we loaded.
// Two members logging in the same instant used to be a lost update (last
// write wins); now the loser reloads and re-applies its mutation.
const CAS_SCRIPT = `
local cur = tonumber(redis.call('GET', KEYS[2]) or '0')
if cur == tonumber(ARGV[2]) then
  redis.call('SET', KEYS[1], ARGV[1], 'EX', tonumber(ARGV[3]))
  redis.call('SET', KEYS[2], tostring(cur + 1), 'EX', tonumber(ARGV[3]))
  return 1
end
return 0
`;

const trySaveTeam = async (team: Team, expectedVersion: number): Promise<boolean> => {
  if (redisClient) {
    try {
      const ok = await redisClient.eval(
        CAS_SCRIPT,
        [teamKey(team.id), versionKey(team.id)],
        [JSON.stringify(team), String(expectedVersion), String(TTL_SECONDS)]
      );
      return Number(ok) === 1;
    } catch (err) {
      console.error('[ladder] save failed for', team.id, err);
      throw err;
    }
  }
  localStore.set(team.id, team);
  return true;
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

// Backfill: any legacy member without `active` is treated as active.
const ensureActiveFlag = (team: Team) => {
  for (const m of team.members) {
    if (m.active === undefined) m.active = true;
  }
};

type MutationOutcome =
  | { error: string; status: number }
  | { result: Record<string, any> };

// Load → mutate → compare-and-set, retrying on conflict so concurrent
// writers (two members logging in the same second) never lose updates.
const withTeam = async (
  teamId: string,
  mutate: (team: Team) => MutationOutcome
): Promise<Response> => {
  for (let attempt = 0; attempt < 3; attempt++) {
    const loaded = await loadTeam(teamId);
    if (!loaded) return json({ error: 'team not found' }, 404);
    const { team, version } = loaded;
    ensureActiveFlag(team);
    const out = mutate(team);
    if ('error' in out) return json({ error: out.error }, out.status);
    if (await trySaveTeam(team, version)) return json(out.result);
  }
  return json({ error: 'the ladder is busy — try again' }, 409);
};

export const POST: APIRoute = async ({ request, url }) => {
  try {
    const action = url.searchParams.get('action') || '';
    let body: any = {};
    try { body = await request.json(); } catch { /* allow empty */ }

    // CREATE
    if (action === 'create') {
      const t = newTeam();
      await saveTeam(t);
      return json({ teamId: t.id, team: t });
    }

    // All other actions need a teamId
    const teamId = String(body?.teamId || '').trim();
    if (!teamId || teamId.length > 32) return json({ error: 'invalid teamId' }, 400);

    // GET (read-only — no CAS needed)
    if (action === 'get') {
      const loaded = await loadTeam(teamId);
      if (!loaded) return json({ error: 'team not found' }, 404);
      ensureActiveFlag(loaded.team);
      return json({ team: loaded.team });
    }

    // JOIN
    if (action === 'join') {
      const handle = sanitizeHandle(String(body?.handle || ''));
      const path = String(body?.path || '').trim();
      if (!handle || handle.length < 1) return json({ error: 'handle required' }, 400);
      if (!validPath(path)) return json({ error: 'invalid path' }, 400);
      return withTeam(teamId, (team) => {
        const existing = team.members.find((m) => m.handle === handle);
        const oldN = activeCount(team);
        if (existing) {
          // Re-joining: allow path change. Reactivate if previously stepped out.
          existing.path = path;
          existing.active = true;
        } else {
          if (team.members.length >= 12) return { error: 'team full (12)', status: 400 };
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
        return { result: { team } };
      });
    }

    // STEP_OUT — soft pause. Toggle active flag; rescale HP.
    if (action === 'step_out' || action === 'step_in') {
      const handle = sanitizeHandle(String(body?.handle || ''));
      return withTeam(teamId, (team) => {
        const member = team.members.find(m => m.handle === handle);
        if (!member) return { error: 'not a team member', status: 400 };
        const oldN = activeCount(team);
        member.active = action === 'step_in';
        const newN = activeCount(team);
        rescaleHpForSizeChange(team, oldN, newN);
        return { result: { team } };
      });
    }

    // LOG
    if (action === 'log') {
      const handle = sanitizeHandle(String(body?.handle || ''));
      const exerciseId = String(body?.exerciseId || '').trim();
      const amountRaw = Number(body?.amount);
      if (!Number.isFinite(amountRaw) || amountRaw <= 0) return json({ error: 'invalid amount' }, 400);
      const amount = Math.min(Math.floor(amountRaw), 1000);
      return withTeam(teamId, (team) => {
        const member = team.members.find((m) => m.handle === handle);
        if (!member) return { error: 'not a team member', status: 400 };
        if (member.active === false) return { error: 'you are stepped out — step back in to log', status: 400 };
        const ex = (data.exercises as any[]).find((e) => e.id === exerciseId);
        if (!ex) return { error: 'unknown exercise', status: 400 };
        const boss = (data.bosses as any[])[team.currentBossIdx];
        if (!boss) return { error: 'no active boss', status: 400 };
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
        return { result: { team, dealt, calc, hitLine, defeated, advancedBoss } };
      });
    }

    // ADVANCE (manual nudge if needed)
    if (action === 'advance') {
      return withTeam(teamId, (team) => {
        if (team.currentBossHp > 0) return { error: 'current boss still alive', status: 400 };
        if (team.currentBossIdx + 1 >= (data.bosses as any[]).length) return { error: 'top of ladder', status: 400 };
        team.currentBossIdx += 1;
        team.currentBossHp = (data.bosses as any[])[team.currentBossIdx].hp * Math.max(1, activeCount(team));
        return { result: { team } };
      });
    }

    return json({ error: 'unknown action' }, 400);
  } catch (err) {
    console.error('[ladder] request failed:', err);
    return json({ error: 'the ladder wobbled. try again.' }, 500);
  }
};
