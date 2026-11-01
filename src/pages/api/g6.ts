// Feed for the private in-car page at /g6 (Mick's XPeng G6 Pro).
// One call returns everything the Now panel needs for a lat/lon:
//   NEA (data.gov.sg v2): air temperature + humidity (nearest station),
//   2-hour forecast (nearest area), 24h PSI + 1h PM2.5 (nearest region).
//   Open-Meteo: feels-like temperature + day/night flag (no key, free).
//
// Why a server route and not fetch-from-the-browser: NEA's keyless tier
// throttles bursts hard (429 after ~6 quick calls). Here the raw feeds are
// cached in module memory for 60s and shared by every request that lands on
// the same lambda, and a stale copy is served if NEA is mid-tantrum.
//
// Location: ?lat=&lon= from the car's GPS. If the browser refuses, Vercel's
// x-vercel-ip-latitude/longitude headers give a coarse fix (island-level in
// SG). If even that is missing we fall back to central Singapore.

import type { APIRoute } from 'astro';
import { clientIp, rateLimit, json429, fetchWithTimeout } from '../../lib/api-util';

export const prerender = false;

const NEA = 'https://api-open.data.gov.sg/v2/real-time/api';
const OPEN_METEO = 'https://api.open-meteo.com/v1/forecast';
const DEFAULT = { lat: 1.3521, lon: 103.8198 }; // central SG

type LatLon = { lat: number; lon: number };
type Cached = { at: number; value: any; stale: boolean };

// Module-level caches survive between warm invocations of the same lambda.
const neaCache: Map<string, Cached> = (globalThis as any).__g6Nea ||= new Map();
const meteoCache: Map<string, Cached> = (globalThis as any).__g6Meteo ||= new Map();

const NEA_TTL = 60_000;        // NEA temp/humidity tick every minute
const SLOW_TTL = 5 * 60_000;   // forecast / PSI / PM2.5 move hourly at most
const METEO_TTL = 15 * 60_000; // Open-Meteo "current" is a 15-min product

const km = (a: LatLon, b: LatLon) => {
  const dLat = (b.lat - a.lat) * 111;
  const dLon = (b.lon - a.lon) * 111 * Math.cos((a.lat * Math.PI) / 180);
  return Math.hypot(dLat, dLon);
};

const nearest = <T>(items: T[], at: LatLon, pos: (t: T) => LatLon): T | undefined => {
  let best: T | undefined;
  let bestD = Infinity;
  for (const it of items) {
    const d = km(at, pos(it));
    if (d < bestD) { bestD = d; best = it; }
  }
  return best;
};

// Fetch-with-memory: returns the cached value when fresh, otherwise refetches.
// On failure it keeps serving the last good value (marked stale) rather than
// blanking the dashboard.
const remembered = async (cache: Map<string, Cached>, key: string, ttl: number, url: string): Promise<Cached> => {
  const hit = cache.get(key);
  const now = Date.now();
  if (hit && hit.value && now - hit.at < ttl) return hit;
  try {
    let res = await fetchWithTimeout(url, { headers: { accept: 'application/json' } }, 6000);
    if (res.status === 429) {
      // Cold start fires eight NEA calls at once and the keyless tier
      // sometimes bounces one. A short pause and one retry clears it.
      await new Promise((r) => setTimeout(r, 1200));
      res = await fetchWithTimeout(url, { headers: { accept: 'application/json' } }, 6000);
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const value = await res.json();
    const entry = { at: now, value, stale: false };
    cache.set(key, entry);
    return entry;
  } catch (err) {
    console.warn(`[g6] ${key} failed — ${(err as Error).message}`);
    if (hit?.value) { hit.stale = true; return hit; }
    return { at: now, value: null, stale: true };
  }
};

// NEA PSI bands (24-hour PSI) and 1-hour PM2.5 bands — the official cut-offs.
const psiBand = (v: number) =>
  v <= 50 ? 'good' : v <= 100 ? 'moderate' : v <= 200 ? 'unhealthy' : v <= 300 ? 'very unhealthy' : 'hazardous';
const pm25Band = (v: number) =>
  v <= 55 ? 'normal' : v <= 150 ? 'elevated' : v <= 250 ? 'high' : 'very high';

// Station-based feeds (air-temperature, relative-humidity) share one shape.
const stationReading = (feed: any, at: LatLon) => {
  const stations: any[] = feed?.data?.stations || [];
  const readings: any[] = feed?.data?.readings?.[0]?.data || [];
  const byId = new Map(readings.map((r: any) => [r.stationId, r.value]));
  const live = stations.filter((s) => byId.has(s.id));
  const s = nearest(live, at, (x) => ({ lat: x.location.latitude, lon: x.location.longitude }));
  return s ? { value: byId.get(s.id) as number, station: s.name as string, ts: feed.data.readings[0].timestamp as string } : null;
};

// Region-based feeds (psi, pm25) share one shape.
const regionFor = (feed: any, at: LatLon): string | null => {
  const regions: any[] = feed?.data?.regionMetadata || [];
  const r = nearest(regions, at, (x) => ({ lat: x.labelLocation.latitude, lon: x.labelLocation.longitude }));
  return r?.name || null;
};

const STUB = {
  source: 'stub',
  area: 'Bishan', forecast: 'Partly Cloudy (Night)',
  tempC: 27.3, feelsC: 31.0, humidity: 86, station: 'Ang Mo Kio Avenue 5',
  psi: 62, psiBand: 'moderate', pm25: 29, pm25Band: 'normal', region: 'central',
  isDay: false, stale: false, hours: [] as any[], day24: null as any, days: [] as any[],
};

export const GET: APIRoute = async ({ request, clientAddress }) => {
  const ip = clientIp(request, clientAddress);
  const rl = await rateLimit(`g6:${ip}`, 40, 60);
  if (!rl.allowed) return json429('easy — the sky changes slowly.', rl.retryAfterSeconds);

  const url = new URL(request.url);
  const qLat = parseFloat(url.searchParams.get('lat') || '');
  const qLon = parseFloat(url.searchParams.get('lon') || '');
  const hLat = parseFloat(request.headers.get('x-vercel-ip-latitude') || '');
  const hLon = parseFloat(request.headers.get('x-vercel-ip-longitude') || '');

  let at: LatLon = DEFAULT;
  let locSource: 'gps' | 'ip' | 'default' = 'default';
  if (Number.isFinite(qLat) && Number.isFinite(qLon)) { at = { lat: qLat, lon: qLon }; locSource = 'gps'; }
  else if (Number.isFinite(hLat) && Number.isFinite(hLon)) { at = { lat: hLat, lon: hLon }; locSource = 'ip'; }

  // Open-Meteo is keyed by a 2-decimal grid (~1km) so a moving car doesn't
  // bust the cache every refresh.
  const grid = `${at.lat.toFixed(2)},${at.lon.toFixed(2)}`;
  const meteoUrl = `${OPEN_METEO}?latitude=${at.lat.toFixed(3)}&longitude=${at.lon.toFixed(3)}&current=apparent_temperature,is_day&hourly=temperature_2m,precipitation_probability,weather_code,is_day&forecast_hours=7&timezone=Asia%2FSingapore`;

  const [temp, hum, fc, psi, pm25, meteo, d24, d4] = await Promise.all([
    remembered(neaCache, 'air-temperature', NEA_TTL, `${NEA}/air-temperature`),
    remembered(neaCache, 'relative-humidity', NEA_TTL, `${NEA}/relative-humidity`),
    remembered(neaCache, 'two-hr-forecast', SLOW_TTL, `${NEA}/two-hr-forecast`),
    remembered(neaCache, 'psi', SLOW_TTL, `${NEA}/psi`),
    remembered(neaCache, 'pm25', SLOW_TTL, `${NEA}/pm25`),
    remembered(meteoCache, grid, METEO_TTL, meteoUrl),
    // 24-hour forecast + 4-day outlook feed the in-page forecast sheet
    // (NEA's own pages are unreadable at arm's length in a car).
    remembered(neaCache, 'twenty-four-hr-forecast', SLOW_TTL, `${NEA}/twenty-four-hr-forecast`),
    remembered(neaCache, 'four-day-outlook', SLOW_TTL, `${NEA}/four-day-outlook`),
  ]);

  const nothing = [temp, hum, fc, psi, pm25].every((c) => !c.value);
  if (nothing) {
    // Offline dev or NEA fully down: keep the page alive with a labelled stub.
    return Response.json(
      { ...STUB, locSource, lat: at.lat, lon: at.lon, updated: new Date().toISOString() },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  }

  const t = stationReading(temp.value, at);
  const h = stationReading(hum.value, at);

  // 2-hour forecast: 47 named areas with label coordinates.
  const areas: any[] = fc.value?.data?.area_metadata || [];
  const area = nearest(areas, at, (x) => ({ lat: x.label_location.latitude, lon: x.label_location.longitude }));
  const fcItem = fc.value?.data?.items?.[0];
  const forecast = fcItem?.forecasts?.find((f: any) => f.area === area?.name)?.forecast || null;

  const region = regionFor(psi.value, at) || regionFor(pm25.value, at) || 'central';
  const psi24 = psi.value?.data?.items?.[0]?.readings?.psi_twenty_four_hourly?.[region];
  const pm = pm25.value?.data?.items?.[0]?.readings?.pm25_one_hourly?.[region];

  const cur = meteo.value?.current;
  // Next 6 hours from Open-Meteo. forecast_hours=7 starts at the current
  // hour, so drop the first entry (it's "now", already on screen).
  const hz = meteo.value?.hourly;
  const hours = Array.isArray(hz?.time)
    ? hz.time.slice(1, 7).map((t: string, i: number) => ({
        t,
        temp: hz.temperature_2m?.[i + 1] ?? null,
        pop: hz.precipitation_probability?.[i + 1] ?? null,
        code: hz.weather_code?.[i + 1] ?? null,
        day: hz.is_day?.[i + 1] === 1,
      }))
    : [];
  // 24-hour forecast: island-wide general outlook plus three 6/12-hour
  // periods, each with a forecast per NEA region — we keep the car's region.
  const rec24 = d24.value?.data?.records?.[0];
  const g = rec24?.general;
  const day24 = g
    ? {
        text: g.forecast?.text ?? null,
        code: g.forecast?.code ?? null,
        tempLo: g.temperature?.low ?? null, tempHi: g.temperature?.high ?? null,
        humLo: g.relativeHumidity?.low ?? null, humHi: g.relativeHumidity?.high ?? null,
        windDir: g.wind?.direction ?? null, windLo: g.wind?.speed?.low ?? null, windHi: g.wind?.speed?.high ?? null,
        valid: g.validPeriod?.text ?? null,
        updated: rec24.updatedTimestamp ?? null,
        periods: (rec24.periods || []).map((p: any) => ({
          when: p.timePeriod?.text ?? '',
          start: p.timePeriod?.start ?? null,
          end: p.timePeriod?.end ?? null,
          text: p.regions?.[region]?.text ?? p.regions?.central?.text ?? null,
          code: p.regions?.[region]?.code ?? p.regions?.central?.code ?? null,
        })),
      }
    : null;
  const rec4 = d4.value?.data?.records?.[0];
  const days = (rec4?.forecasts || []).map((f: any) => ({
    day: f.day ?? null,
    date: f.timestamp ?? null,
    text: f.forecast?.text ?? null,
    code: f.forecast?.code ?? null,
    summary: f.forecast?.summary ?? null,
    lo: f.temperature?.low ?? null, hi: f.temperature?.high ?? null,
    windDir: f.wind?.direction ?? null, windLo: f.wind?.speed?.low ?? null, windHi: f.wind?.speed?.high ?? null,
  }));

  const hour = Number(new Date().toLocaleString('en-SG', { timeZone: 'Asia/Singapore', hour: 'numeric', hour12: false }));
  const isDay = typeof cur?.is_day === 'number' ? cur.is_day === 1 : hour >= 7 && hour < 19;

  const body = {
    source: 'live',
    locSource,
    lat: at.lat, lon: at.lon,
    area: area?.name || null,
    forecast,
    tempC: t?.value ?? null,
    station: t?.station || null,
    feelsC: typeof cur?.apparent_temperature === 'number' ? cur.apparent_temperature : null,
    humidity: h?.value ?? null,
    psi: typeof psi24 === 'number' ? psi24 : null,
    psiBand: typeof psi24 === 'number' ? psiBand(psi24) : null,
    pm25: typeof pm === 'number' ? pm : null,
    pm25Band: typeof pm === 'number' ? pm25Band(pm) : null,
    region,
    isDay,
    hours,
    day24,
    days,
    updated: t?.ts || new Date().toISOString(),
    stale: [temp, hum, fc, psi, pm25].some((c) => c.stale),
  };

  return Response.json(body, { headers: { 'Cache-Control': 'no-store' } });
};
