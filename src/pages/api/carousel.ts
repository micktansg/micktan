// Weave Carousel Engine — hidden team tool at /carousel.
// POST /api/carousel
//   generate: { password, article, slideTarget?: 'auto'|6|8|10 }
//     → { title, source, slides:[{kind,title,body}], caption_instagram, caption_linkedin, hashtags }
//   revise:   { password, mode:'revise', article, slides, instruction, scope:'all'|number,
//               caption_instagram, caption_linkedin, hashtags }
//     → scope 'all': full carousel JSON (as above) | scope N: { kind, title, body }
//
// Protection layers, in order:
//   1. per-IP rate limit (also throttles password brute-forcing)
//   2. server-side password check (CAROUSEL_PASSWORD env var) — wrong password
//      means Gemini is never called, so a leaked URL costs nothing
//   3. global daily budget so even password holders can't run up the meter

import type { APIRoute } from 'astro';
import { createHash, timingSafeEqual } from 'node:crypto';
import { env, clientIp, rateLimitWithBudget, json429, fetchWithTimeout } from '../../lib/api-util';

export const prerender = false;

const GEMINI_URL =
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent';

// ---------- password ----------

const passwordOk = (supplied: unknown): boolean => {
  const expected = env('CAROUSEL_PASSWORD');
  if (!expected || !supplied) return false;
  const a = createHash('sha256').update(String(supplied)).digest();
  const b = createHash('sha256').update(String(expected)).digest();
  return timingSafeEqual(a, b);
};

// ---------- the editorial brief for Gemini ----------

const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    title: { type: 'STRING', description: 'Short internal working title for this carousel' },
    source: {
      type: 'STRING',
      description:
        'Attribution for the article: publication and/or authors and year if identifiable, else empty string',
    },
    slides: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          kind: { type: 'STRING', enum: ['hook', 'content', 'cta'] },
          title: { type: 'STRING' },
          body: { type: 'STRING' },
        },
        required: ['kind', 'title', 'body'],
      },
    },
    caption_instagram: { type: 'STRING' },
    caption_linkedin: { type: 'STRING' },
    hashtags: { type: 'ARRAY', items: { type: 'STRING' } },
  },
  required: ['title', 'source', 'slides', 'caption_instagram', 'caption_linkedin', 'hashtags'],
};

const SLIDE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    kind: { type: 'STRING', enum: ['hook', 'content', 'cta'] },
    title: { type: 'STRING' },
    body: { type: 'STRING' },
  },
  required: ['kind', 'title', 'body'],
};

const VOICE_RULES = `VOICE (strict)
- UK English. NEVER use em dashes or en dashes anywhere; use commas, full stops or colons instead.
- Confident, specific, observational. Lead with the insight, never with credentials or throat-clearing.
- No hype words (game-changer, revolutionary, unlock, elevate). No preachy closing morals.
- Numbers beat adjectives. Keep any statistic exactly as the article states it; never invent or round beyond what is written.

LENGTH LIMITS per slide kind
- hook: title max 12 words, body max 15 words
- content: title max 8 words, body max 30 words, ONE idea per slide
- cta: title max 10 words, body max 25 words`;

const buildRevisePrompt = (
  article: string,
  carousel: any,
  instruction: string,
  scope: 'all' | number
): string => {
  const common = `You are the content editor at Weave, a Singapore video production company (weave.com.sg). Earlier you turned the article below into a carousel for Instagram and LinkedIn. The team may have manually edited it since; treat the CURRENT CAROUSEL as the version to improve. Never undo their edits except where the instruction requires it.

${VOICE_RULES}

TEAM INSTRUCTION: "${instruction}"`;

  if (scope === 'all') {
    return `${common}

Apply the instruction across the carousel. Only change what the instruction requires: keep the slide count, order and kinds, the captions and the hashtags unchanged unless the instruction clearly asks for them to change. Return the FULL carousel JSON matching the schema, with your changes applied and everything else passed through as-is.

ARTICLE (context):
"""
${article}
"""

CURRENT CAROUSEL:
${JSON.stringify(carousel, null, 1)}`;
  }
  return `${common}

Rewrite ONLY slide ${scope + 1} (index ${scope}, shown in the carousel below) according to the instruction. Keep its "kind" the same. Return just that one slide as JSON matching the schema.

ARTICLE (context):
"""
${article}
"""

CURRENT CAROUSEL:
${JSON.stringify(carousel, null, 1)}`;
};

const buildPrompt = (article: string, slideTarget: number | 'auto'): string => {
  const target =
    slideTarget === 'auto'
      ? 'Use between 7 and 10 slides total, whichever the material honestly supports.'
      : `Use exactly ${slideTarget} slides total.`;
  return `You are the content editor at Weave, a Singapore video production company (weave.com.sg). You turn articles into carousel posts for Instagram and LinkedIn. Weave's audience: marketing leads, brand and comms teams, agency producers.

Distil the article below into ONE carousel.

STRUCTURE
- Slide 1 must be kind "hook": a bold claim, surprising number, or sharp question drawn from the article's single most interesting finding. Title max 12 words. Body max 15 words (a one-line teaser of what the carousel delivers; may be empty if the title carries it).
- Middle slides are kind "content": exactly ONE idea per slide. Title max 8 words, punchy, plain language. Body max 30 words, one or two short sentences that earn the title. No filler like "in this slide".
- Last slide must be kind "cta": title is a short takeaway or invitation (max 10 words), body max 25 words. Invite readers to save/share the post or follow Weave for more. Never salesy, never begging.
- ${target}
- Order content slides so each one makes the reader want the next. Front-load the strongest material.

VOICE (strict)
- UK English. NEVER use em dashes or en dashes anywhere; use commas, full stops or colons instead.
- Confident, specific, observational. Lead with the insight, never with credentials or throat-clearing.
- No hype words (game-changer, revolutionary, unlock, elevate). No preachy closing morals.
- Numbers beat adjectives. Keep any statistic exactly as the article states it; never invent or round beyond what is written.
- If the article's evidence is thin or mixed, say so honestly on a slide. Credibility is the brand.

CAPTIONS
- caption_instagram: 80 to 130 words. First line is a scroll-stopper (it gets truncated after ~125 characters, so make those count). Short paragraphs with line breaks. End with a save/share nudge. Do NOT include hashtags in the caption text.
- caption_linkedin: 100 to 180 words. First line must hook before the "see more" fold. Professional but human, no corporate padding. One thought per paragraph. End with a question that invites comments.
- hashtags: 4 to 6, lowercase, no # symbol, mixing one or two broad tags with niche ones relevant to the topic.

SOURCE
- Fill "source" with the article's publication, authors and year where identifiable (e.g. "Nature Human Behaviour, Smith et al., 2025"). Empty string if truly unknown. Never fabricate.

Return only JSON matching the schema.

ARTICLE:
"""
${article}
"""`;
};

// ---------- gemini ----------

const callGemini = async (
  apiKey: string,
  prompt: string,
  schema: object
): Promise<any | null> => {
  try {
    const r = await fetchWithTimeout(
      `${GEMINI_URL}?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.5,
            maxOutputTokens: 8192,
            responseMimeType: 'application/json',
            responseSchema: schema,
          },
        }),
      },
      50_000
    );
    if (!r.ok) {
      const errBody = await r.text().catch(() => '');
      console.error('[carousel] Gemini non-OK', r.status, errBody.slice(0, 300));
      return null;
    }
    const data = await r.json();
    const text: string | undefined = data?.candidates?.[0]?.content?.parts
      ?.map((p: any) => p?.text || '')
      .join('');
    if (!text) return null;
    return JSON.parse(text);
  } catch (e) {
    console.error('[carousel] Gemini exception', (e as Error).message);
    return null;
  }
};

// ---------- route ----------

const json = (status: number, obj: unknown) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

export const POST: APIRoute = async ({ request, clientAddress }) => {
  let body: any;
  try { body = await request.json(); }
  catch { return json(400, { error: 'Bad JSON' }); }

  // Layer 1: per-IP window (counts wrong-password attempts too) + layer 3
  // global daily budget, via the shared limiter.
  const rl = await rateLimitWithBudget({
    scope: 'carousel',
    ip: clientIp(request, clientAddress),
    perIp: 8,
    windowSeconds: 600,
    dailyBudget: 150,
  });
  if (!rl.allowed) return json429('Slow down. Try again in a bit.', rl.retryAfterSeconds);

  // Layer 2: the password.
  if (!passwordOk(body?.password)) return json(401, { error: 'Wrong password.' });

  const article = String(body?.article || '').trim().slice(0, 60_000);
  if (article.length < 300) {
    return json(400, { error: 'That looks too short to be an article. Paste the full text.' });
  }
  const apiKey = env('GEMINI_API_KEY');
  if (!apiKey) return json(500, { error: 'Server is missing GEMINI_API_KEY.' });

  // Belt and braces: strip any dashes the model sneaks through.
  const clean = (s: unknown) => String(s ?? '').replace(/\s*[–—]\s*/g, ', ').trim();
  const cleanSlide = (s: any) => ({
    kind: ['hook', 'content', 'cta'].includes(s?.kind) ? s.kind : 'content',
    title: clean(s?.title).slice(0, 120),
    body: clean(s?.body).slice(0, 300),
  });
  const cleanCarousel = (result: any) => {
    result.slides = result.slides.slice(0, 12).map(cleanSlide);
    result.title = clean(result.title).slice(0, 120);
    result.source = clean(result.source).slice(0, 200);
    result.caption_instagram = clean(result.caption_instagram).slice(0, 2200);
    result.caption_linkedin = clean(result.caption_linkedin).slice(0, 3000);
    result.hashtags = (Array.isArray(result.hashtags) ? result.hashtags : [])
      .slice(0, 8)
      .map((h: unknown) => String(h).replace(/[^a-z0-9]/gi, '').toLowerCase())
      .filter(Boolean);
    return result;
  };

  // ----- revise mode: fine-tune the current carousel per team instruction -----
  if (body?.mode === 'revise') {
    const instruction = String(body?.instruction || '').trim().slice(0, 400);
    if (instruction.length < 3) {
      return json(400, { error: 'Tell the robot what to change first.' });
    }
    const slides = (Array.isArray(body?.slides) ? body.slides : []).slice(0, 12).map(cleanSlide);
    if (slides.length < 3) return json(400, { error: 'No carousel to revise. Generate one first.' });

    const carousel = {
      title: clean(body?.title).slice(0, 120),
      source: clean(body?.source).slice(0, 200),
      slides,
      caption_instagram: clean(body?.caption_instagram).slice(0, 2200),
      caption_linkedin: clean(body?.caption_linkedin).slice(0, 3000),
      hashtags: (Array.isArray(body?.hashtags) ? body.hashtags : []).slice(0, 8).map(clean),
    };

    const scopeNum = Number(body?.scope);
    const scope: 'all' | number =
      Number.isInteger(scopeNum) && scopeNum >= 0 && scopeNum < slides.length ? scopeNum : 'all';

    if (scope === 'all') {
      const result = await callGemini(apiKey, buildRevisePrompt(article, carousel, instruction, 'all'), RESPONSE_SCHEMA);
      if (!result || !Array.isArray(result.slides) || result.slides.length < 3) {
        return json(502, { error: 'The model choked on that one. Try again in a moment.' });
      }
      return json(200, cleanCarousel(result));
    }
    const slide = await callGemini(apiKey, buildRevisePrompt(article, carousel, instruction, scope), SLIDE_SCHEMA);
    if (!slide || !slide.title) {
      return json(502, { error: 'The model choked on that one. Try again in a moment.' });
    }
    const out = cleanSlide(slide);
    out.kind = slides[scope].kind; // never let a revision change the slide's role
    return json(200, { slide: out, scope });
  }

  // ----- generate mode -----
  const slideTarget: number | 'auto' = [6, 8, 10].includes(Number(body?.slideTarget))
    ? Number(body?.slideTarget)
    : 'auto';

  const result = await callGemini(apiKey, buildPrompt(article, slideTarget), RESPONSE_SCHEMA);
  if (!result || !Array.isArray(result.slides) || result.slides.length < 3) {
    return json(502, { error: 'The model choked on that one. Try again in a moment.' });
  }
  return json(200, cleanCarousel(result));
};
