// Single endpoint for /room/domsday — performance training coach.
// POST /api/domsday?action=<verb>
//   plan    { userId, intake }                        → generate cited training plan
//   load    { userId }                                → fetch saved state
//   save    { userId, state }                         → upsert client-side state
//   log     { userId, log: {...} }                    → log a session
//   refine  { userId, message }                       → Coach replies, may revise plan
//   metric  { userId, metric: {...} }                 → log daily metrics (sleep/weight/etc)
//   delete  { userId }                                → wipe stored state for this user
//
// Falls back to a deterministic stubbed plan when GEMINI_API_KEY is unset (dev),
// and to in-memory storage when Upstash isn't configured (also dev).

import type { APIRoute } from 'astro';
import { Redis } from '@upstash/redis';

export const prerender = false;
// Allow long generations (Gemini grounded plans for 26-52 weeks can take 30-50s).
// Default Vercel function timeout is 10s on Hobby; this raises it to the cap (60s).
export const maxDuration = 60;

type Intake = {
  goalTags: string[];
  goalNarrative: string;
  experience: 'beginner' | 'intermediate' | 'advanced';
  daysPerWeek: number;
  minutesPerSession: number;
  timelineWeeks: number;
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

type Phase = {
  name: string;
  description: string;
  startWeek: number;
  endWeek: number;
};

type Tip = { tip: string; rationale: string };

type Citation = { title: string; url: string; domain: string };

type SourceTheme = {
  name: string;
  description: string;
  citationIndices: number[];
};

type CoachMessage = {
  ts: number;
  kind: 'intro' | 'regen' | 'streak' | 'concern' | 'reply' | 'log' | 'reflect' | 'user' | 'metric';
  body: string;
};

type Plan = {
  title: string;
  summary: string;
  durationWeeks: number;
  startDate: string; // ISO YYYY-MM-DD
  phases: Phase[];
  weeks: Week[];
  diet_tips: Tip[];
  lifestyle_tips: Tip[];
  citations: Citation[];
  source_themes: SourceTheme[];
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

type MetricEntry = {
  ts: number;
  date: string; // YYYY-MM-DD
  sleepHours: number | null;
  weightKg: number | null;
  energy: number | null;   // 1-5
  mood: number | null;     // 1-5
  proteinHit: boolean | null;
  waterLiters: number | null;
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
  metricsLog: MetricEntry[];
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
    await redisClient.set(stateKey(s.userId), JSON.stringify(s), { ex: 60 * 60 * 24 * 365 });
    return;
  }
  localStore.set(s.userId, s);
};

const json = (obj: any, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const isoDate = (d = new Date()) => {
  const y = d.getFullYear(); const m = String(d.getMonth() + 1).padStart(2, '0'); const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
};

// ---------- Gemini: plan ----------

const COACH_PERSONA = `You are Coach — a performance training coach. Tone: warm, attentive, encouraging, but firm when a client cheats or skips without good reason. You speak like a respected professional: clear, evidence-based, plain-spoken. No preachy moralizing, no toxic hustle, no emojis.`;

const phaseGuidanceFor = (weeks: number): string => {
  if (weeks <= 8)  return '1–2 phases (e.g. Foundation → Progress).';
  if (weeks <= 14) return '2–3 phases (e.g. Foundation → Build → Test).';
  if (weeks <= 20) return '3–4 phases (e.g. Foundation → Build → Peak → Recover).';
  if (weeks <= 30) return '4–5 phases across the arc.';
  return '5–6 phases across the arc, with planned recovery weeks every 4–6 weeks.';
};

const buildPlanPrompt = (intake: Intake, startDate: string) => {
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

  const weeks = intake.timelineWeeks;

  return `${COACH_PERSONA}

Generate a personalised ${weeks}-week training roadmap, starting ${startDate}.

CLIENT INTAKE
Goal tags: ${intake.goalTags.join(', ') || 'general fitness'}
Goal in their words: ${intake.goalNarrative || '(none)'}
Experience: ${intake.experience}
Time: ${intake.daysPerWeek} days/week, ~${intake.minutesPerSession} min/session
Timeline: ${weeks} weeks total
Restrictions/injuries: ${intake.restrictions || 'none stated'}
${flagsLine}
Metrics: ${metrics}
Current activity: ${intake.currentActivity || '(not stated)'}

REQUIREMENTS
1. Ground every recommendation in real research. Use Google Search aggressively. Strongly prefer pubmed.ncbi.nlm.nih.gov, cochranelibrary.com, NIH, ACSM, .gov, .edu, peer-reviewed reviews.
2. Match session count to their available days/week. Don't exceed it. Include rest days.
3. Build PHASES: ${phaseGuidanceFor(weeks)} Each phase has a name, one-sentence description, and continuous startWeek/endWeek.
4. Progress sensibly week-by-week with deload/recovery weeks built in (one every 4–6 weeks for plans 12+ weeks).
5. Diet & lifestyle tips: 3-5 each, each one actionable, each with a short rationale.
6. source_themes: group the search results you cited into 2-5 broad TOPIC themes (e.g. "Protein intake & recovery", "Aerobic base building", "Periodization", "Mobility & joint health"). Each theme: name (short), description (one sentence), match_titles (array of 1-3 substrings that appear in the titles of grounding results that fall under this theme — used to associate citations server-side).
7. coach_message: warm welcome from Coach (90-130 words). Restate the goal in your own words. Acknowledge any restrictions/conditions with care. Set the stake of week 1 specifically. No signoff name.
8. KEEP IT TERSE. session "details" ≤ 25 words. "title" ≤ 6 words. "focus" ≤ 15 words. The full JSON must complete — do not truncate. Better to be brief and complete than detailed and cut off.

OUTPUT — a single valid JSON object, no markdown fences, no commentary:
{
  "title": "short plan name",
  "summary": "1-2 sentence overview",
  "phases": [
    { "name": "Foundation", "description": "...", "startWeek": 1, "endWeek": 4 }
  ],
  "weeks": [
    {
      "weekNum": 1,
      "focus": "what this week is doing in the bigger arc",
      "sessions": [
        {
          "day": "mon",
          "type": "strength|cardio|mobility|rest|skill|recovery",
          "title": "short label",
          "duration": 45,
          "intensity": "low|moderate|high|rest",
          "details": "1-2 sentences on what they're doing and why"
        }
      ]
    }
  ],
  "diet_tips": [{ "tip": "...", "rationale": "..." }],
  "lifestyle_tips": [{ "tip": "...", "rationale": "..." }],
  "source_themes": [
    { "name": "...", "description": "...", "match_titles": ["substring1", "substring2"] }
  ],
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
  catch (e1) {
    // Try stripping inline citation markers Gemini often inserts (e.g. [1], [1, 2], [3,4,5])
    // when grounding is enabled. Only strip ones that look like citations (single or
    // comma-separated digits inside brackets, not inside word chars).
    const stripped = jsonStr
      .replace(/(?<=[^\w])\[\s*\d+(?:\s*,\s*\d+)*\s*\](?=[^\w]|$)/g, '')
      .replace(/\s+,/g, ',') // tidy double commas left behind
      .replace(/,(\s*[}\]])/g, '$1'); // remove trailing commas
    try { parsed = JSON.parse(stripped); }
    catch (e2) {
      console.error('[domsday] JSON parse fail', (e1 as Error).message);
      return null;
    }
  }

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
          maxOutputTokens: 32000,
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

const associateThemes = (themes: Array<{ name: string; description: string; match_titles?: string[] }>, citations: Citation[]): SourceTheme[] => {
  if (!themes || !themes.length) return [];
  const used = new Set<number>();
  const out: SourceTheme[] = [];
  for (const t of themes) {
    const matches: number[] = [];
    const subs = (t.match_titles || []).map(s => String(s || '').toLowerCase()).filter(Boolean);
    citations.forEach((c, idx) => {
      if (used.has(idx)) return;
      const title = c.title.toLowerCase();
      if (subs.some(sub => title.includes(sub))) {
        matches.push(idx);
        used.add(idx);
      }
    });
    if (matches.length || (t.name && t.description)) {
      out.push({
        name: String(t.name || '').slice(0, 80),
        description: String(t.description || '').slice(0, 240),
        citationIndices: matches,
      });
    }
  }
  // Bucket the leftovers
  const leftovers: number[] = [];
  citations.forEach((_, idx) => { if (!used.has(idx)) leftovers.push(idx); });
  if (leftovers.length) {
    out.push({
      name: 'Other sources',
      description: 'Additional references used.',
      citationIndices: leftovers,
    });
  }
  return out;
};

const callGeminiPlan = async (apiKey: string, intake: Intake, startDate: string): Promise<{ plan: Plan; coachMessage: string } | null> => {
  // First try with grounded search (gives real citations).
  let r = await callGemini(apiKey, buildPlanPrompt(intake, startDate), true);
  let parsed = r ? parseGroundedJson(r.text, { groundingMetadata: { groundingChunks: r.citations.map(c => ({ web: { uri: c.url, title: c.title } })) } }) : null;

  // Fallback: if grounded JSON parsing failed (often due to truncation on long
  // timelines), retry without grounding. The plan will lack citations but at
  // least the user gets a real plan instead of the stub.
  if (!parsed) {
    console.warn('[domsday] grounded plan parse failed, retrying without grounding');
    r = await callGemini(apiKey, buildPlanPrompt(intake, startDate), false);
    parsed = r ? parseGroundedJson(r.text, { groundingMetadata: { groundingChunks: [] } }) : null;
  }
  if (!parsed || !r) return null;
  const p = parsed.parsed;
  const sourceThemes = associateThemes(p.source_themes || [], r.citations);
  const plan: Plan = {
    title: String(p.title || 'Your Protocol').slice(0, 80),
    summary: String(p.summary || '').slice(0, 400),
    durationWeeks: intake.timelineWeeks,
    startDate,
    phases: Array.isArray(p.phases) ? p.phases.slice(0, 8).map((ph: any) => ({
      name: String(ph.name || 'Phase').slice(0, 40),
      description: String(ph.description || '').slice(0, 240),
      startWeek: Math.max(1, Number(ph.startWeek) || 1),
      endWeek: Math.max(1, Number(ph.endWeek) || 1),
    })) : [],
    weeks: Array.isArray(p.weeks) ? p.weeks.slice(0, 60) : [],
    diet_tips: Array.isArray(p.diet_tips) ? p.diet_tips.slice(0, 8) : [],
    lifestyle_tips: Array.isArray(p.lifestyle_tips) ? p.lifestyle_tips.slice(0, 8) : [],
    citations: r.citations,
    source_themes: sourceThemes,
  };
  return { plan, coachMessage: String(p.coach_message || 'The protocol begins.').slice(0, 1200) };
};

// ---------- Gemini: refine ----------

const buildRefinePrompt = (intake: Intake, plan: Plan, recentLogs: SessionLog[], recentMetrics: MetricEntry[], message: string) => {
  const logsLine = recentLogs.length
    ? recentLogs.slice(0, 12).map(l => `  - W${l.weekNum} ${l.day} ${l.status}${l.rpe ? ` rpe=${l.rpe}` : ''}${l.energy ? ` energy=${l.energy}/5` : ''}${l.soreness ? ` soreness=${l.soreness}/5` : ''}${l.notes ? ` "${l.notes.slice(0, 80)}"` : ''}`).join('\n')
    : '  (no logs yet)';
  const metricsLine = recentMetrics.length
    ? recentMetrics.slice(0, 7).map(m => `  - ${m.date}${m.sleepHours ? ` sleep=${m.sleepHours}h` : ''}${m.weightKg ? ` weight=${m.weightKg}kg` : ''}${m.energy ? ` energy=${m.energy}/5` : ''}${m.mood ? ` mood=${m.mood}/5` : ''}${m.proteinHit !== null ? ` protein=${m.proteinHit ? 'hit' : 'missed'}` : ''}${m.notes ? ` "${m.notes.slice(0, 60)}"` : ''}`).join('\n')
    : '  (no metrics yet)';

  return `${COACH_PERSONA}

The client is asking you to adjust their plan or talking through their training. Decide whether their request requires a structural plan revision, or just a coach reply.

CURRENT PLAN
Title: ${plan.title}
Duration: ${plan.durationWeeks} weeks (started ${plan.startDate})
Phases: ${plan.phases.map(ph => `${ph.name} (W${ph.startWeek}-${ph.endWeek})`).join(' → ')}
Weeks: ${plan.weeks.length}

INTAKE
Goal tags: ${intake.goalTags.join(', ') || 'general fitness'}
Goal: ${intake.goalNarrative || '(none)'}
Restrictions: ${intake.restrictions || 'none'}
Time: ${intake.daysPerWeek}d/wk, ${intake.minutesPerSession}min

RECENT SESSION LOGS
${logsLine}

RECENT DAILY METRICS
${metricsLine}

CLIENT MESSAGE
"${message.slice(0, 1000)}"

DECIDE
- If the client is asking for a real change (swap days, lower volume, add session, change focus, deload, sub an exercise, recover from injury) → set should_update_plan=true and return updated_plan with the FULL revised plan in the same shape as before.
- If they just want acknowledgement, encouragement, a question answered, or to vent → set should_update_plan=false and just return coach_reply.

Coach reply: 60-140 words, warm, attentive. If the client is making excuses or skipping repeatedly without good reason, be FIRM but not cold — name what's happening and ask them to commit. Acknowledge metric trends if relevant (sleep dropping, weight changing, low mood). Praise honest effort. No emojis. No signoff name.

If updating the plan, only revise WEEKS that need changing — keep prior weeks already lived through intact unless they explicitly ask. Use Google Search to ground new prescriptions in research when adding/changing exercises or methods.

OUTPUT — a single JSON object, no markdown fences:
{
  "should_update_plan": true|false,
  "coach_reply": "...",
  "updated_plan": { "title": "...", "summary": "...", "phases": [...], "weeks": [...], "diet_tips": [...], "lifestyle_tips": [...] }
}`;
};

const callGeminiRefine = async (
  apiKey: string,
  intake: Intake,
  plan: Plan,
  recentLogs: SessionLog[],
  recentMetrics: MetricEntry[],
  message: string
): Promise<{ coachReply: string; updatedPlan: Plan | null } | null> => {
  // Drop grounding for refine — grounded JSON output from Gemini is finicky and
  // breaks too often. Coach can talk about training without live search; plan
  // revisions inherit existing citations.
  const r = await callGemini(apiKey, buildRefinePrompt(intake, plan, recentLogs, recentMetrics, message), false);
  if (!r) return null;
  const parsed = parseGroundedJson(r.text, { groundingMetadata: { groundingChunks: [] } });
  if (!parsed) {
    // Last-resort: extract a coach_reply field by regex so the user gets *something*.
    const m = r.text.match(/"coach_reply"\s*:\s*"([\s\S]*?)"\s*[,}]/);
    if (m && m[1]) {
      return { coachReply: m[1].replace(/\\n/g, '\n').replace(/\\"/g, '"').slice(0, 1200), updatedPlan: null };
    }
    return null;
  }
  const p = parsed.parsed;
  const coachReply = String(p.coach_reply || '').slice(0, 1200);
  if (!coachReply) return null;
  let updatedPlan: Plan | null = null;
  if (p.should_update_plan && p.updated_plan && typeof p.updated_plan === 'object') {
    const up = p.updated_plan;
    const mergedCitations = [...plan.citations, ...r.citations.filter(c => !plan.citations.some(x => x.url === c.url))].slice(0, 60);
    updatedPlan = {
      title: String(up.title || plan.title).slice(0, 80),
      summary: String(up.summary || plan.summary).slice(0, 400),
      durationWeeks: plan.durationWeeks,
      startDate: plan.startDate,
      phases: Array.isArray(up.phases) && up.phases.length ? up.phases.slice(0, 8).map((ph: any) => ({
        name: String(ph.name || 'Phase').slice(0, 40),
        description: String(ph.description || '').slice(0, 240),
        startWeek: Math.max(1, Number(ph.startWeek) || 1),
        endWeek: Math.max(1, Number(ph.endWeek) || 1),
      })) : plan.phases,
      weeks: Array.isArray(up.weeks) ? up.weeks.slice(0, 60) : plan.weeks,
      diet_tips: Array.isArray(up.diet_tips) ? up.diet_tips.slice(0, 8) : plan.diet_tips,
      lifestyle_tips: Array.isArray(up.lifestyle_tips) ? up.lifestyle_tips.slice(0, 8) : plan.lifestyle_tips,
      citations: mergedCitations,
      source_themes: plan.source_themes, // keep grouping; user can regen for fresh themes
    };
  }
  return { coachReply, updatedPlan };
};

// ---------- Local stubs ----------

const stubPlan = (intake: Intake, startDate: string): { plan: Plan; coachMessage: string } => {
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

  const weeks: Week[] = Array.from({ length: intake.timelineWeeks }, (_, w) => ({
    weekNum: w + 1,
    focus: w === 0 ? 'Establish baseline. Honest effort, conservative load.'
         : (w + 1) % 5 === 0 ? 'Deload — recover, reassess.'
         : `Week ${w + 1}: small load and volume bumps.`,
    sessions: [
      ...trainingDays.map((d, i) => sessionFor(d, i + w)),
      ...restDays.map((d): Session => ({ day: d, type: 'rest', title: 'Rest', duration: 0, intensity: 'rest', details: 'Sleep, walk, eat.' })),
    ],
  }));

  // Synthesize phases
  const phaseCount = intake.timelineWeeks <= 8 ? 2 : intake.timelineWeeks <= 14 ? 3 : intake.timelineWeeks <= 20 ? 4 : 5;
  const phases: Phase[] = [];
  const per = Math.ceil(intake.timelineWeeks / phaseCount);
  const phaseNames = ['Foundation', 'Build', 'Peak', 'Recover', 'Build 2', 'Peak 2'];
  for (let i = 0; i < phaseCount; i++) {
    const startWeek = i * per + 1;
    const endWeek = Math.min(intake.timelineWeeks, (i + 1) * per);
    phases.push({
      name: phaseNames[i] || `Phase ${i + 1}`,
      description: 'Stub phase — connect API for live phase planning.',
      startWeek, endWeek,
    });
    if (endWeek >= intake.timelineWeeks) break;
  }

  return {
    plan: {
      title: 'Stub Protocol — connect API for live plan',
      summary: 'Local fallback plan. Set GEMINI_API_KEY on Vercel for the live cited version.',
      durationWeeks: intake.timelineWeeks,
      startDate,
      phases,
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
      source_themes: [],
    },
    coachMessage: `Welcome. I read your intake — ${intake.goalNarrative ? `"${intake.goalNarrative.slice(0, 80)}"` : intake.goalTags.join(', ') || 'general fitness'} — and drafted a ${intake.timelineWeeks}-week starter protocol. This is stub mode — the live coach (Gemini) isn't connected here. When it is, every recommendation comes with the research it leans on. For now: treat week 1 as honest reconnaissance. Show up, log how it felt, we'll calibrate from there.`,
  };
};

const stubLogReply = (log: SessionLog, recent: SessionLog[]): string => {
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
  if (recentSkip >= 2) {
    return `That's ${recentSkip} skips recently. Tell me what's actually getting in the way — life, motivation, recovery, the plan itself? I can adjust if the load isn't right. I can't help if we don't name it.`;
  }
  return `Skipped — fine, life happens. ${log.notes ? 'Heard your reason.' : 'No drama.'} Don't compound it. Show up tomorrow.`;
};

const stubMetricReply = (m: MetricEntry, recent: MetricEntry[]): string => {
  const lowSleep = m.sleepHours !== null && m.sleepHours < 6;
  const lowEnergy = m.energy !== null && m.energy <= 2;
  const lowMood = m.mood !== null && m.mood <= 2;
  if (lowSleep && lowEnergy) return `Sleep at ${m.sleepHours}h with energy ${m.energy}/5 — that's a recovery deficit. Today's session: cut volume 30% or swap for mobility. We don't push under-recovered.`;
  if (lowMood) return `Logged. Low mood today (${m.mood}/5). Don't try to PR through it. Move easy, eat, hydrate, get out in daylight. Tomorrow we re-check.`;
  if (m.proteinHit === false) return `Metrics in. Missing protein consistently undercuts recovery — even one day off-target adds up. Tomorrow: front-load protein at breakfast.`;
  if (recent.length >= 3) return `Metrics logged. Trend looks steady — the consistency is the asset.`;
  return `Metrics logged. Good signal for me to calibrate by.`;
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
  const allowedTimelines = [6, 12, 16, 26, 36, 52];
  const tlRaw = Number(raw.timelineWeeks);
  const timelineWeeks = allowedTimelines.includes(tlRaw) ? tlRaw : 26;
  const restrictions = String(raw.restrictions || '').slice(0, 800);
  const healthFlags = Array.isArray(raw.healthFlags) ? raw.healthFlags.filter((s: any) => typeof s === 'string').slice(0, 8).map((s: string) => s.slice(0, 40)) : [];
  const numOrNull = (v: any, min: number, max: number): number | null => {
    const n = Number(v);
    if (!Number.isFinite(n)) return null;
    if (n < min || n > max) return null;
    return Math.round(n * 10) / 10;
  };
  return {
    goalTags, goalNarrative, experience,
    daysPerWeek, minutesPerSession, timelineWeeks,
    restrictions, healthFlags,
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
  const weekNum = Math.max(1, Math.min(60, Number(raw.weekNum) || 0));
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
    weekNum, day, ts: Date.now(), status,
    rpe: numOrNull(raw.rpe, 1, 10),
    energy: numOrNull(raw.energy, 1, 5),
    soreness: numOrNull(raw.soreness, 1, 5),
    notes: String(raw.notes || '').slice(0, 400),
  };
};

const cleanMetric = (raw: any): MetricEntry | null => {
  if (!raw || typeof raw !== 'object') return null;
  const dateStr = String(raw.date || '').match(/^\d{4}-\d{2}-\d{2}$/) ? String(raw.date) : isoDate();
  const numOrNull = (v: any, min: number, max: number): number | null => {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    if (!Number.isFinite(n)) return null;
    if (n < min || n > max) return null;
    return Math.round(n * 10) / 10;
  };
  return {
    ts: Date.now(),
    date: dateStr,
    sleepHours: numOrNull(raw.sleepHours, 0, 16),
    weightKg: numOrNull(raw.weightKg, 25, 350),
    energy: numOrNull(raw.energy, 1, 5),
    mood: numOrNull(raw.mood, 1, 5),
    proteinHit: typeof raw.proteinHit === 'boolean' ? raw.proteinHit : null,
    waterLiters: numOrNull(raw.waterLiters, 0, 12),
    notes: String(raw.notes || '').slice(0, 400),
  };
};

const validUserId = (id: string) => /^[a-z0-9-]{8,40}$/i.test(id);

const ensureArrays = (s: State): State => {
  if (!Array.isArray(s.sessionLogs)) s.sessionLogs = [];
  if (!Array.isArray(s.metricsLog)) s.metricsLog = [];
  if (!Array.isArray(s.coachLog)) s.coachLog = [];
  if (!Array.isArray(s.history)) s.history = [];
  if (s.plan) {
    if (!Array.isArray(s.plan.phases)) s.plan.phases = [];
    if (!Array.isArray(s.plan.source_themes)) s.plan.source_themes = [];
    if (!s.plan.startDate) s.plan.startDate = isoDate(new Date(s.createdAt));
    if (!s.plan.durationWeeks) s.plan.durationWeeks = s.plan.weeks?.length || 6;
  }
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
    const startDate = isoDate();
    let plan: Plan;
    let coachMessageBody: string;

    if (apiKey) {
      const result = await callGeminiPlan(apiKey, intake, startDate);
      if (result) {
        plan = result.plan;
        coachMessageBody = result.coachMessage;
      } else {
        const fb = stubPlan(intake, startDate);
        plan = fb.plan;
        coachMessageBody = fb.coachMessage + '  (Live coach call failed — showing fallback.)';
      }
    } else {
      const fb = stubPlan(intake, startDate);
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
      ],
      history: existing?.plan
        ? [{ ts: existing.updatedAt, plan: existing.plan }, ...((existing as any)?.history || [])].slice(0, 12)
        : [],
      sessionLogs: [],
      metricsLog: existing?.metricsLog || [], // keep daily metrics across regenerations
    };
    await saveState(state);
    return json({ state });
  }

  if (action === 'load') {
    let state = await loadState(userId);
    if (state) state = ensureArrays(state);
    return json({ state });
  }

  if (action === 'delete') {
    if (redisClient) await redisClient.del(stateKey(userId));
    else localStore.delete(userId);
    return json({ ok: true });
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
      sessionLogs: Array.isArray(incoming.sessionLogs) ? incoming.sessionLogs.slice(0, 600) : (existing?.sessionLogs || []),
      metricsLog: Array.isArray(incoming.metricsLog) ? incoming.metricsLog.slice(0, 800) : (existing?.metricsLog || []),
    };
    await saveState(merged);
    return json({ state: merged });
  }

  if (action === 'log') {
    const log = cleanLog(body?.log);
    if (!log) return json({ error: 'invalid log' }, 400);
    const existing = await loadState(userId);
    if (!existing || !existing.plan) return json({ error: 'no plan to log against' }, 400);
    ensureArrays(existing);

    existing.sessionLogs = [
      log,
      ...existing.sessionLogs.filter(l => !(l.weekNum === log.weekNum && l.day === log.day)),
    ].slice(0, 600);

    const recent = existing.sessionLogs.slice(0, 14);
    const reply = stubLogReply(log, recent);
    existing.coachLog = [
      { ts: Date.now(), kind: 'log', body: reply },
      ...(existing.coachLog || []).slice(0, 60),
    ];

    await saveState(existing);
    return json({ state: existing });
  }

  if (action === 'metric') {
    const metric = cleanMetric(body?.metric);
    if (!metric) return json({ error: 'invalid metric' }, 400);
    const existing = await loadState(userId);
    if (!existing) return json({ error: 'no state' }, 400);
    ensureArrays(existing);

    // Replace any prior metric for the same date (one entry per day)
    existing.metricsLog = [
      metric,
      ...existing.metricsLog.filter(m => m.date !== metric.date),
    ].slice(0, 800);

    const recent = existing.metricsLog.slice(0, 7);
    const reply = stubMetricReply(metric, recent);
    existing.coachLog = [
      { ts: Date.now(), kind: 'metric', body: reply },
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
    ensureArrays(existing);

    const apiKey = env('GEMINI_API_KEY');
    let coachReply: string;
    let updatedPlan: Plan | null = null;

    if (apiKey) {
      const r = await callGeminiRefine(apiKey, existing.intake, existing.plan, existing.sessionLogs, existing.metricsLog, message);
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
