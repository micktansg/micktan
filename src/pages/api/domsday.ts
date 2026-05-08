// Single endpoint for /room/domsday — Dr DOMs personal training coach.
// POST /api/domsday?action=<verb>
//   plan   { userId, intake }              → Gemini-generated cited training plan
//   load   { userId }                      → fetch saved state
//   save   { userId, state }               → upsert state (used later for tracking)
//   message{ userId, message, currentPlan }→ Dr DOMs replies + may revise plan (Phase 2 stub)
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
  status?: 'pending' | 'done' | 'skipped' | 'modified';
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
  kind: 'intro' | 'regen' | 'streak' | 'concern' | 'reply';
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

type State = {
  userId: string;
  createdAt: number;
  updatedAt: number;
  intake: Intake;
  plan: Plan | null;
  coachLog: CoachMessage[];
  history: { ts: number; plan: Plan }[];
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
    // 180-day expiry — abandoned plans clean themselves up
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

// ---------- Gemini ----------

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

  return `You are Dr DOMs — a performance training coach. Tone: warm, attentive, encouraging, but firm when a client cheats or skips without good reason. You sound like a respected professional coach: clear, evidence-based, no preachy moralizing, no toxic hustle. You sign off "— Dr DOMs".

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
5. coach_message: warm welcome from Dr DOMs (90-130 words). Restate the goal in your own words. Acknowledge any restrictions/conditions with care. Set the stake of week 1 specifically. Sign off "— Dr DOMs".

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
  "coach_message": "Dr DOMs intro paragraph"
}`;
};

const callGeminiPlan = async (apiKey: string, prompt: string): Promise<{ plan: Plan; coachMessage: string; citations: Citation[] } | null> => {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        tools: [{ googleSearch: {} }],
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
    const text: string | undefined = cand?.content?.parts?.map((p: any) => p?.text || '').join('') || cand?.content?.parts?.[0]?.text;
    if (!text) {
      console.error('[domsday] Gemini empty text');
      return null;
    }

    // Extract JSON from text — sometimes wrapped in fences despite instruction.
    let jsonStr = text.trim();
    const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch) jsonStr = fenceMatch[1].trim();
    // Find first { ... last } fallback
    const firstBrace = jsonStr.indexOf('{');
    const lastBrace = jsonStr.lastIndexOf('}');
    if (firstBrace >= 0 && lastBrace > firstBrace) jsonStr = jsonStr.slice(firstBrace, lastBrace + 1);

    let parsed: any;
    try { parsed = JSON.parse(jsonStr); }
    catch (e) {
      console.error('[domsday] JSON parse fail', (e as Error).message, jsonStr.slice(0, 200));
      return null;
    }

    // Citations from grounding metadata
    const groundingChunks = cand?.groundingMetadata?.groundingChunks || [];
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

    const plan: Plan = {
      title: String(parsed.title || 'Your Protocol').slice(0, 80),
      summary: String(parsed.summary || '').slice(0, 400),
      weeks: Array.isArray(parsed.weeks) ? parsed.weeks.slice(0, 12) : [],
      diet_tips: Array.isArray(parsed.diet_tips) ? parsed.diet_tips.slice(0, 8) : [],
      lifestyle_tips: Array.isArray(parsed.lifestyle_tips) ? parsed.lifestyle_tips.slice(0, 8) : [],
      citations,
    };

    return {
      plan,
      coachMessage: String(parsed.coach_message || 'The protocol begins. — Dr DOMs').slice(0, 1200),
      citations,
    };
  } catch (e) {
    console.error('[domsday] Gemini exception', (e as Error).message);
    return null;
  }
};

// ---------- Local stub (dev / Gemini failure) ----------

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
      status: 'pending',
    };
  };

  const weeks: Week[] = Array.from({ length: 6 }, (_, w) => ({
    weekNum: w + 1,
    focus: w === 0 ? 'Establish baseline. Honest effort, conservative load.'
         : w === 5 ? 'Deload — recover, reassess.'
         : `Progress: small load and volume bumps.`,
    sessions: [
      ...trainingDays.map((d, i) => sessionFor(d, i + w)),
      ...restDays.map((d): Session => ({ day: d, type: 'rest', title: 'Rest', duration: 0, intensity: 'rest', details: 'Sleep, walk, eat.', status: 'pending' })),
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
    coachMessage: `Welcome. I read your intake — ${intake.goalNarrative ? `"${intake.goalNarrative.slice(0, 80)}"` : intake.goalTags.join(', ') || 'general fitness'} — and I've drafted a 6-week starter protocol. This is a stub plan because the live coach (Gemini) isn't connected here. Once it is, every recommendation comes with the research it leans on. For now: treat week 1 as honest reconnaissance. Show up, log how it felt, we'll calibrate from there. — Dr DOMs (stub mode)`,
  };
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

const validUserId = (id: string) => /^[a-z0-9-]{8,40}$/i.test(id);

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
        ? [{ ts: existing.updatedAt, plan: existing.plan }, ...(existing.history || [])].slice(0, 12)
        : [],
    };
    await saveState(state);
    return json({ state });
  }

  if (action === 'load') {
    const state = await loadState(userId);
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
    };
    await saveState(merged);
    return json({ state: merged });
  }

  return json({ error: 'unknown action' }, 400);
};
