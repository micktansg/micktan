// Single endpoint for /room/domsday — performance training coach.
// POST /api/domsday?action=<verb>
//   plan    { userId, intake }                        → generate cited training plan
//   load    { userId }                                → fetch saved state
//   save    { userId, state }                         → upsert client-side state
//   log     { userId, log: { weekNum, day, status, rpe, energy, soreness, notes } }
//   refine  { userId, message }                       → Coach replies, may revise plan
//
// Falls back to a deterministic stubbed plan when GEMINI_API_KEY is unset (dev),
// and to in-memory storage when Upstash isn't configured (also dev).

import type { APIRoute } from 'astro';
import { Redis } from '@upstash/redis';

export const prerender = false;

type Intake = {
  goalTags: string[];
  goalNarrative: string;
  experience: 'beginner' | 'intermediate' | 'advanced';
  daysPerWeek: number;
  minutesPerSession: number;
  restrictions: string;
  healthFlags: string[];
  age: number | null;
  weightKg: number | null;
  heightCm: number | null;
  restingHr: number | null;
  sleepHours: number | null;
  currentActivity: string;
};

type Session = {
  day: 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';
  type: 'strength' | 'cardio' | 'mobility' | 'rest' | 'skill' | 'recovery';
  title: string;
  duration: number;
  intensity: 'low' | 'moderate' | 'high' | 'rest';
  details: string;
};

type Week = {
  weekNum: number;
  focus: string;
  sessions: Session[];
};

type Tip = { tip: string; rationale: string };

type Citation = { title: string; url: string; domain: string };

type CoachMessage = {
  ts: number;
  kind: 'intro' | 'regen' | 'streak' | 'concern' | 'reply' | 'log' | 'reflect';
  body: string;
};

type Plan = {
  title: string;
  summary: string;
  weeks: Week[];
  diet_tips: Tip[];
  lifestyle_tips: Tip[];
  citations: Citation[];
};

type SessionLog = {
  weekNum: number;
  day: string;
  ts: number;
  status: 'done' | 'skipped' | 'modified';
  rpe: number | null;
  energy: number | null;
  soreness: number | null;
  notes: string;
};

type State = {
  userId: string;
  createdAt: number;
  updatedAt: number;
  intake: Intake;
  plan: Plan | null;
  coachLog: CoachMessage[];
  history: { ts: number; plan: Plan }[];
  sessionLogs: SessionLog[];
};

const env = (k: string): string | undefined =>
  ((import.meta as any).env?.[k] || (globalThis as any).process?.env?.[k]) as string | undefined;

const redisClient = (() => {
  const url = env('UPSTASH_REDIS_REST_URL');
  const token = env('UPSTASH_REDIS_REST_TOKEN');
  if (!url || !token) return null;
  return new Redis({ url, token });
})();

const localStore: Map<string, State> = (globalThis as any).__domsdayLocal ||= new Map();

const stateKey = (id: string) => `domsday:user:${id}`;

const loadState = async (id: string): Promise<State | null> => {
  if (redisClient) {
    const raw = await redisClient.get(stateKey(id));
    if (!raw) return null;
    return typeof raw === 'string' ? JSON.parse(raw) : (raw as State);
  }
  return localStore.get(id) || null;
};

const saveState = async (s: State): Promise<void> => {
  s.updatedAt = Date.now();
  if (redisClient) {
    await redisClient.set(stateKey(s.userId), JSON.stringify(s), { ex: 60 * 60 * 24 * 180 });
    return;
  }
  localStore.set(s.userId, s);
};

const json = (obj: any, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

// ---------- Gemini: plan ----------

const COACH_PERSONA = `You are Coach — a performance training coach. Tone: warm, attentive, encouraging, but firm when a client cheats or skips without good reason. You speak like a respected professional: clear, evidence-based, plain-spoken. No preachy moralizing, no toxic hustle, no emojis.`;

const buildPlanPrompt = (intake: Intake) => {
  const flagsLine = intake.healthFlags.length
    ? `Flagged conditions: ${intake.healthFlags.join(', ')} — be CONSERVATIVE, advise clinician sign-off, lean lower intensity.`
    : 'No flagged conditions.';
  const metrics = [
    intake.age ? `age ${intake.age}` : null,
    intake.weightKg ? `weight ${intake.weightKg}kg` : null,
    intake.heightCm ? `height ${intake.heightCm}cm` : null,
    intake.restingHr ? `resting HR ${intake.restingHr}` : null,
    intake.sleepHours ? `sleep avg ${intake.sleepHours}h` : null,
  ].filter(Boolean).join(', ') || 'no metrics provided';

  return `${COACH_PERSONA}

Generate a personalised 6-week training roadmap.

CLIENT INTAKE
Goal tags: ${intake.goalTags.join(', ') || 'general fitness'}
Goal in their words: ${intake.goalNarrative || '(none)'}
Experience: ${intake.experience}
Time: ${intake.daysPerWeek} days/week, ~${intake.minutesPerSession} min/session
Restrictions/injuries: ${intake.restrictions || 'none stated'}
${flagsLine}
Metrics: ${metrics}
Current activity: ${intake.currentActivity || '(not stated)'}

REQUIREMENTS
1. Ground every recommendation in real research. Use Google Search aggressively. Strongly prefer pubmed.ncbi.nlm.nih.gov, cochranelibrary.com, NIH, ACSM, .gov, .edu, peer-reviewed reviews.
2. Match session count to their available days/week. Don't exceed it. Include rest days.
3. Progress sensibly across the 6 weeks (deload week if appropriate).
4. Diet & lifestyle tips: 3-5 each, each one actionable, each with a short rationale.
5. coach_message: warm welcome from Coach (90-130 words). Restate the goal in your own words. Acknowledge any restrictions/conditions with care. Set the stake of week 1 specifically. No signoff name.

OUTPUT — a single valid JSON object, no markdown fences, no commentary:
{
  "title": "short plan name",
  "summary": "1-2 sentence overview",
  "weeks": [
    {
      "weekNum": 1,
      "focus": "what this week is doing in the bigger arc",
      "sessions": [
        {
          "day": "mon",
          "type": "strength|cardio|mobility|rest|skill|recovery",
          "title": "short label, e.g. Lower body — squat focus",
          "duration": 45,
          "intensity": "low|moderate|high|rest",
          "details": "1-2 sentences on what they're doing and why"
        }
      ]
    }
  ],
  "diet_tips": [{ "tip": "...", "rationale": "..." }],
  "lifestyle_tips": [{ "tip": "...", "rationale": "..." }],
  "coach_message": "Coach's intro paragraph"
}`;
};

const parseGroundedJson = (text: string, candidate: any): { parsed: any; citations: Citation[] } | null => {
  let jsonStr = text.trim();
  const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) jsonStr = fenceMatch[1].trim();
  const firstBrace = jsonStr.indexOf('{');
  const lastBrace = jsonStr.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) jsonStr = jsonStr.slice(firstBrace, lastBrace + 1);

  let parsed: any;
  try { parsed = JSON.parse(jsonStr); }
  catch { return null; }

  const groundingChunks = candidate?.groundingMetadata?.groundingChunks || [];
  const citations: Citation[] = [];
  const seen = new Set<string>();
  for (const c of groundingChunks) {
    const w = c?.web;
    if (!w?.uri) continue;
    if (seen.has(w.uri)) continue;
    seen.add(w.uri);
    let domain = '';
    try { domain = new URL(w.uri).hostname.replace(/^www\./, ''); } catch { domain = ''; }
    citations.push({
      title: (w.title || domain || w.uri).slice(0, 160),
      url: w.uri,
      domain,
    });
  }
  return { parsed, citations };
};

const callGemini = async (apiKey: string, prompt: string, useGrounding = true): Promise<{ text: string; citations: Citation[] } | null> => {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        ...(useGrounding ? { tools: [{ googleSearch: {} }] } : {}),
        generationConfig: {
          temperature: 0.7,
          maxOutputTokens: 8000,
        },
      }),
    });
    if (!r.ok) {
      const errBody = await r.text().catch(() => '');
      console.error('[domsday] Gemini non-OK', r.status, errBody.slice(0, 300));
      return null;
    }
    const data = await r.json();
    const cand = data?.candidates?.[0];
    const text: string = cand?.content?.parts?.map((p: any) => p?.text || '').join('') || '';
    if (!text) return null;
    const groundingChunks = cand?.groundingMetadata?.groundingChunks || [];
    const citations: Citation[] = [];
    const seen = new Set<string>();
    for (const c of groundingChunks) {
      const w = c?.web;
      if (!w?.uri || seen.has(w.uri)) continue;
      seen.add(w.uri);
      let domain = '';
      try { domain = new URL(w.uri).hostname.replace(/^www\./, ''); } catch { domain = ''; }
      citations.push({
        title: (w.title || domain || w.uri).slice(0, 160),
        url: w.uri,
        domain,
      });
    }
    return { text, citations };
  } catch (e) {
    console.error('[domsday] Gemini exception', (e as Error).message);
    return null;
  }
};

const callGeminiPlan = async (apiKey: string, prompt: string): Promise<{ plan: Plan; coachMessage: string } | null> => {
  const r = await callGemini(apiKey, prompt, true);
  if (!r) return null;
  const parsed = parseGroundedJson(r.text, { groundingMetadata: { groundingChunks: r.citations.map(c => ({ web: { uri: c.url, title: c.title } })) } });
  if (!parsed) return null;
  const p = parsed.parsed;
  const plan: Plan = {
    title: String(p.title || 'Your Protocol').slice(0, 80),
    summary: String(p.summary || '').slice(0, 400),
    weeks: Array.isArray(p.weeks) ? p.weeks.slice(0, 12) : [],
    diet_tips: Array.isArray(p.diet_tips) ? p.diet_tips.slice(0, 8) : [],
    lifestyle_tips: Array.isArray(p.lifestyle_tips) ? p.lifestyle_tips.slice(0, 8) : [],
    citations: r.citations,
  };
  return { plan, coachMessage: String(p.coach_message || 'The protocol begins.').slice(0, 1200) };
};

// ---------- Gemini: refine ----------

const buildRefinePrompt = (intake: Intake, plan: Plan, recentLogs: SessionLog[], message: string) => {
  const logsLine = recentLogs.length
    ? recentLogs.slice(0, 12).map(l => `  - W${l.weekNum} ${l.day} ${l.status}${l.rpe ? ` rpe=${l.rpe}` : ''}${l.energy ? ` energy=${l.energy}/5` : ''}${l.soreness ? ` soreness=${l.soreness}/5` : ''}${l.notes ? ` "${l.notes.slice(0, 80)}"` : ''}`).join('\n')
    : '  (no logs yet)';

  return `${COACH_PERSONA}

The client is asking you to adjust their plan or talking through their training. Decide whether their request requires a structural plan revision, or just a coach reply.

CURRENT PLAN
Title: ${plan.title}
Summary: ${plan.summary}
Weeks: ${plan.weeks.length}

INTAKE
Goal tags: ${intake.goalTags.join(', ') || 'general fitness'}
Goal: ${intake.goalNarrative || '(none)'}
Restrictions: ${intake.restrictions || 'none'}
Time: ${intake.daysPerWeek}d/wk, ${intake.minutesPerSession}min

RECENT LOGS
${logsLine}

CLIENT MESSAGE
"${message.slice(0, 1000)}"

DECIDE
- If the client is asking for a real change (swap days, lower volume, add session, change focus, deload, sub an exercise, recover from injury) → set should_update_plan=true and return updated_plan with the FULL revised plan in the same shape as before.
- If they just want acknowledgement, encouragement, a question answered, or to vent → set should_update_plan=false and just return coach_reply.

Coach reply: 60-140 words, warm, attentive. If the client is making excuses or skipping repeatedly without good reason, be FIRM but not cold — name what's happening and ask them to commit. Praise honest effort. No emojis. No signoff name.

If updating the plan, only revise WEEKS that need changing — keep prior weeks already lived through (lower than the current week the client is working in) intact unless they explicitly ask. Use Google Search to ground new prescriptions in research when adding/changing exercises or methods.

OUTPUT — a single JSON object, no markdown fences:
{
  "should_update_plan": true|false,
  "coach_reply": "...",
  "updated_plan": { "title": "...", "summary": "...", "weeks": [...], "diet_tips": [...], "lifestyle_tips": [...] }   // only if should_update_plan true
}`;
};

const callGeminiRefine = async (
  apiKey: string,
  intake: Intake,
  plan: Plan,
  recentLogs: SessionLog[],
  message: string
): Promise<{ coachReply: string; updatedPlan: Plan | null; citations: Citation[] } | null> => {
  const r = await callGemini(apiKey, buildRefinePrompt(intake, plan, recentLogs, message), true);
  if (!r) return null;
  const parsed = parseGroundedJson(r.text, { groundingMetadata: { groundingChunks: r.citations.map(c => ({ web: { uri: c.url, title: c.title } })) } });
  if (!parsed) return null;
  const p = parsed.parsed;
  const coachReply = String(p.coach_reply || '').slice(0, 1200);
  if (!coachReply) return null;
  let updatedPlan: Plan | null = null;
  if (p.should_update_plan && p.updated_plan && typeof p.updated_plan === 'object') {
    const up = p.updated_plan;
    updatedPlan = {
      title: String(up.title || plan.title).slice(0, 80),
      summary: String(up.summary || plan.summary).slice(0, 400),
      weeks: Array.isArray(up.weeks) ? up.weeks.slice(0, 12) : plan.weeks,
      diet_tips: Array.isArray(up.diet_tips) ? up.diet_tips.slice(0, 8) : plan.diet_tips,
      lifestyle_tips: Array.isArray(up.lifestyle_tips) ? up.lifestyle_tips.slice(0, 8) : plan.lifestyle_tips,
      citations: [...plan.citations, ...r.citations].slice(0, 24),
    };
  }
  return { coachReply, updatedPlan, citations: r.citations };
};

// ---------- Local stubs ----------

const stubPlan = (intake: Intake): { plan: Plan; coachMessage: string } => {
  const days: Session['day'][] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
  const trainingDays = days.slice(0, Math.max(2, Math.min(intake.daysPerWeek, 6)));
  const restDays = days.filter(d => !trainingDays.includes(d));
  const wantsStrength = intake.goalTags.some(t => /strength|hypertrophy|muscle/i.test(t));
  const wantsCardio = intake.goalTags.some(t => /endurance|cardio|fat|loss|longev/i.test(t));

  const sessionFor = (day: Session['day'], i: number): Session => {
    const rotation = wantsStrength && wantsCardio
      ? ['strength', 'cardio', 'mobility', 'strength', 'cardio', 'recovery']
      : wantsStrength
      ? ['strength', 'mobility', 'strength', 'recovery', 'strength', 'mobility']
      : wantsCardio
      ? ['cardio', 'mobility', 'cardio', 'recovery', 'cardio', 'mobility']
      : ['strength', 'cardio', 'mobility', 'strength', 'cardio', 'recovery'];
    const type = rotation[i % rotation.length] as Session['type'];
    const titles: Record<string, string> = {
      strength: i % 2 ? 'Upper body — push/pull' : 'Lower body — squat & hinge',
      cardio: 'Aerobic base — Zone 2',
      mobility: 'Mobility & core',
      recovery: 'Active recovery walk',
      skill: 'Skill work',
      rest: 'Rest',
    };
    return {
      day,
      type,
      title: titles[type] || 'Session',
      duration: intake.minutesPerSession,
      intensity: type === 'recovery' || type === 'mobility' ? 'low' : type === 'cardio' ? 'moderate' : 'moderate',
      details: 'Stub session — connect Gemini for grounded prescriptions.',
    };
  };

  const weeks: Week[] = Array.from({ length: 6 }, (_, w) => ({
    weekNum: w + 1,
    focus: w === 0 ? 'Establish baseline. Honest effort, conservative load.'
         : w === 5 ? 'Deload — recover, reassess.'
         : `Progress: small load and volume bumps.`,
    sessions: [
      ...trainingDays.map((d, i) => sessionFor(d, i + w)),
      ...restDays.map((d): Session => ({ day: d, type: 'rest', title: 'Rest', duration: 0, intensity: 'rest', details: 'Sleep, walk, eat.' })),
    ],
  }));

  return {
    plan: {
      title: 'Stub Protocol — connect API for live plan',
      summary: 'Local fallback plan. Set GEMINI_API_KEY on Vercel for the live cited version.',
      weeks,
      diet_tips: [
        { tip: 'Hit ~1.6g/kg of bodyweight in protein daily.', rationale: 'Adequate protein supports recovery and lean mass through training adaptations.' },
        { tip: 'Eat carbs around your hard sessions.', rationale: 'Fuels intensity, accelerates glycogen replenishment.' },
        { tip: 'Hydrate to clear urine, especially on training days.', rationale: 'Even mild dehydration reduces output and recovery.' },
      ],
      lifestyle_tips: [
        { tip: '7–9 hours of sleep, consistent wake time.', rationale: 'Sleep is where adaptation happens. No supplement substitutes it.' },
        { tip: 'Walk 7–10k steps on non-training days.', rationale: 'Low-intensity movement supports recovery and aerobic base.' },
        { tip: 'Take 1 deload week every 4–6 weeks.', rationale: 'Planned recovery prevents overuse plateaus.' },
      ],
      citations: [],
    },
    coachMessage: `Welcome. I read your intake — ${intake.goalNarrative ? `"${intake.goalNarrative.slice(0, 80)}"` : intake.goalTags.join(', ') || 'general fitness'} — and drafted a 6-week starter protocol. This is stub mode — the live coach (Gemini) isn't connected here. When it is, every recommendation comes with the research it leans on. For now: treat week 1 as honest reconnaissance. Show up, log how it felt, we'll calibrate from there.`,
  };
};

const stubLogReply = (log: SessionLog, recent: SessionLog[]): string => {
  const recentDone = recent.filter(l => l.status === 'done').length;
  const recentSkip = recent.filter(l => l.status === 'skipped').length;
  const streak = (() => {
    let n = 0;
    for (const l of recent) {
      if (l.status === 'done') n++; else break;
    }
    return n;
  })();

  if (log.status === 'done') {
    if (log.rpe && log.rpe >= 9) {
      return `Logged. RPE ${log.rpe} is high — protect tomorrow. Eat, sleep, move easy. We push when you're ready, not the other way round.`;
    }
    if (streak >= 3) {
      return `That's ${streak} in a row — clean. The work is starting to compound. Hold the line on sleep and food this week and the gains lock in.`;
    }
    return `Logged. Honest effort. ${log.notes ? 'Heard the note — I\'ll factor it in.' : 'Keep the rhythm.'}`;
  }
  if (log.status === 'modified') {
    return `Modification logged. Adjusting on the fly is part of the work — the alternative is skipping. ${log.notes ? 'Read your reason. Sensible.' : ''} We continue.`;
  }
  // skipped
  if (recentSkip >= 2) {
    return `That's ${recentSkip} skips recently. Tell me what's actually getting in the way — life, motivation, recovery, the plan itself? I can adjust if the load isn't right. I can't help if we don't name it.`;
  }
  return `Skipped — fine, life happens. ${log.notes ? 'Heard your reason.' : 'No drama.'} Don't compound it. Show up tomorrow.`;
};

const stubRefineReply = (message: string): string => {
  return `Stub mode — I can't actually revise the plan without the live coach connected. But I hear you: "${message.slice(0, 80)}". Once GEMINI_API_KEY is set, I'll either tweak weeks or talk through it, depending on what you need.`;
};

// ---------- Validation ----------

const cleanIntake = (raw: any): Intake | null => {
  if (!raw || typeof raw !== 'object') return null;
  const goalTags = Array.isArray(raw.goalTags) ? raw.goalTags.filter((s: any) => typeof s === 'string').slice(0, 6).map((s: string) => s.slice(0, 24)) : [];
  const goalNarrative = String(raw.goalNarrative || '').slice(0, 600);
  const experience = ['beginner', 'intermediate', 'advanced'].includes(raw.experience) ? raw.experience : 'beginner';
  const daysPerWeek = Math.max(1, Math.min(7, Number(raw.daysPerWeek) || 3));
  const minutesPerSession = Math.max(15, Math.min(180, Number(raw.minutesPerSession) || 45));
  const restrictions = String(raw.restrictions || '').slice(0, 800);
  const healthFlags = Array.isArray(raw.healthFlags) ? raw.healthFlags.filter((s: any) => typeof s === 'string').slice(0, 8).map((s: string) => s.slice(0, 40)) : [];
  const numOrNull = (v: any, min: number, max: number): number | null => {
    const n = Number(v);
    if (!Number.isFinite(n)) return null;
    if (n < min || n > max) return null;
    return Math.round(n * 10) / 10;
  };
  return {
    goalTags,
    goalNarrative,
    experience,
    daysPerWeek,
    minutesPerSession,
    restrictions,
    healthFlags,
    age: numOrNull(raw.age, 12, 110),
    weightKg: numOrNull(raw.weightKg, 25, 350),
    heightCm: numOrNull(raw.heightCm, 100, 250),
    restingHr: numOrNull(raw.restingHr, 30, 200),
    sleepHours: numOrNull(raw.sleepHours, 0, 16),
    currentActivity: String(raw.currentActivity || '').slice(0, 600),
  };
};

const cleanLog = (raw: any): SessionLog | null => {
  if (!raw || typeof raw !== 'object') return null;
  const weekNum = Math.max(1, Math.min(52, Number(raw.weekNum) || 0));
  if (!weekNum) return null;
  const validDays = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
  const day = validDays.includes(raw.day) ? raw.day : '';
  if (!day) return null;
  const status: SessionLog['status'] = ['done', 'skipped', 'modified'].includes(raw.status) ? raw.status : 'done';
  const numOrNull = (v: any, min: number, max: number): number | null => {
    const n = Number(v);
    if (!Number.isFinite(n)) return null;
    if (n < min || n > max) return null;
    return Math.round(n * 10) / 10;
  };
  return {
    weekNum,
    day,
    ts: Date.now(),
    status,
    rpe: numOrNull(raw.rpe, 1, 10),
    energy: numOrNull(raw.energy, 1, 5),
    soreness: numOrNull(raw.soreness, 1, 5),
    notes: String(raw.notes || '').slice(0, 400),
  };
};

const validUserId = (id: string) => /^[a-z0-9-]{8,40}$/i.test(id);

const ensureSessionLogs = (s: State): State => {
  if (!Array.isArray(s.sessionLogs)) s.sessionLogs = [];
  return s;
};

// ---------- Routes ----------

export const POST: APIRoute = async ({ request, url }) => {
  const action = url.searchParams.get('action') || '';
  let body: any = {};
  try { body = await request.json(); } catch { /* allow empty */ }

  const userId = String(body?.userId || '').trim();
  if (!validUserId(userId)) return json({ error: 'invalid userId' }, 400);

  if (action === 'plan') {
    const intake = cleanIntake(body?.intake);
    if (!intake) return json({ error: 'invalid intake' }, 400);

    const apiKey = env('GEMINI_API_KEY');
    let plan: Plan;
    let coachMessageBody: string;

    if (apiKey) {
      const result = await callGeminiPlan(apiKey, buildPlanPrompt(intake));
      if (result) {
        plan = result.plan;
        coachMessageBody = result.coachMessage;
      } else {
        const fb = stubPlan(intake);
        plan = fb.plan;
        coachMessageBody = fb.coachMessage + '  (Live coach call failed — showing fallback.)';
      }
    } else {
      const fb = stubPlan(intake);
      plan = fb.plan;
      coachMessageBody = fb.coachMessage;
    }

    const now = Date.now();
    const existing = await loadState(userId);
    const state: State = {
      userId,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
      intake,
      plan,
      coachLog: [
        { ts: now, kind: 'intro', body: coachMessageBody },
        ...((existing?.coachLog || []).slice(0, 50)),
      ],
      history: existing?.plan
        ? [{ ts: existing.updatedAt, plan: existing.plan }, ...(existing?.history || [])].slice(0, 12)
        : [],
      sessionLogs: [], // fresh logs for new plan
    };
    await saveState(state);
    return json({ state });
  }

  if (action === 'load') {
    let state = await loadState(userId);
    if (state) state = ensureSessionLogs(state);
    return json({ state });
  }

  if (action === 'save') {
    const incoming = body?.state;
    if (!incoming || incoming.userId !== userId) return json({ error: 'invalid state' }, 400);
    const existing = await loadState(userId);
    const merged: State = {
      userId,
      createdAt: existing?.createdAt || Date.now(),
      updatedAt: Date.now(),
      intake: incoming.intake || existing?.intake,
      plan: incoming.plan || existing?.plan || null,
      coachLog: Array.isArray(incoming.coachLog) ? incoming.coachLog.slice(0, 60) : (existing?.coachLog || []),
      history: Array.isArray(incoming.history) ? incoming.history.slice(0, 12) : (existing?.history || []),
      sessionLogs: Array.isArray(incoming.sessionLogs) ? incoming.sessionLogs.slice(0, 200) : (existing?.sessionLogs || []),
    };
    await saveState(merged);
    return json({ state: merged });
  }

  if (action === 'log') {
    const log = cleanLog(body?.log);
    if (!log) return json({ error: 'invalid log' }, 400);
    const existing = await loadState(userId);
    if (!existing || !existing.plan) return json({ error: 'no plan to log against' }, 400);
    ensureSessionLogs(existing);

    // Replace any prior log for the same week+day
    existing.sessionLogs = [
      log,
      ...existing.sessionLogs.filter(l => !(l.weekNum === log.weekNum && l.day === log.day)),
    ].slice(0, 200);

    // Coach reply via stub (kept fast/cheap; refine action carries the heavier LLM call)
    const recent = existing.sessionLogs.slice(0, 14);
    const reply = stubLogReply(log, recent);
    existing.coachLog = [
      { ts: Date.now(), kind: 'log', body: reply },
      ...(existing.coachLog || []).slice(0, 60),
    ];

    await saveState(existing);
    return json({ state: existing });
  }

  if (action === 'refine') {
    const message = String(body?.message || '').trim();
    if (!message || message.length > 1000) return json({ error: 'invalid message' }, 400);
    const existing = await loadState(userId);
    if (!existing || !existing.plan) return json({ error: 'no plan to refine' }, 400);
    ensureSessionLogs(existing);

    const apiKey = env('GEMINI_API_KEY');
    let coachReply: string;
    let updatedPlan: Plan | null = null;

    if (apiKey) {
      const r = await callGeminiRefine(apiKey, existing.intake, existing.plan, existing.sessionLogs, message);
      if (r) {
        coachReply = r.coachReply;
        updatedPlan = r.updatedPlan;
      } else {
        coachReply = stubRefineReply(message) + '  (Live call failed.)';
      }
    } else {
      coachReply = stubRefineReply(message);
    }

    if (updatedPlan) {
      existing.history = [
        { ts: existing.updatedAt, plan: existing.plan },
        ...(existing.history || []),
      ].slice(0, 12);
      existing.plan = updatedPlan;
    }

    const now = Date.now();
    existing.coachLog = [
      { ts: now, kind: updatedPlan ? 'regen' : 'reply', body: coachReply },
      { ts: now - 1, kind: 'user', body: message },
      ...(existing.coachLog || []).slice(0, 60),
    ];

    await saveState(existing);
    return json({ state: existing, planUpdated: !!updatedPlan });
  }

  return json({ error: 'unknown action' }, 400);
};
