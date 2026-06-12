import sharp from 'sharp';
import { mkdirSync } from 'node:fs';

const W = 1200, H = 630;

// ---------- homepage: dark field, scan-lined lens, "Observing." ----------
const homeCard = () => {
  const cx = 840, cy = 280, r = 210;
  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <radialGradient id="lens" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="#ffffff"/>
      <stop offset="18%" stop-color="#fafaf5"/>
      <stop offset="42%" stop-color="#ebe9e0"/>
      <stop offset="72%" stop-color="#c8c5b8"/>
      <stop offset="95%" stop-color="#5a574a"/>
      <stop offset="100%" stop-color="#2a2a27"/>
    </radialGradient>
    <pattern id="scan" width="4" height="4" patternUnits="userSpaceOnUse">
      <rect width="4" height="2" fill="rgba(15,15,20,0.05)"/>
    </pattern>
    <clipPath id="lensClip"><circle cx="${cx}" cy="${cy}" r="${r}"/></clipPath>
  </defs>
  <rect width="${W}" height="${H}" fill="#2a2a27"/>
  <circle cx="${cx}" cy="${cy}" r="${r + 14}" fill="none" stroke="#f0ece4" stroke-opacity="0.08" stroke-width="28"/>
  <circle cx="${cx}" cy="${cy}" r="${r}" fill="url(#lens)"/>
  <g clip-path="url(#lensClip)">
    <rect x="${cx - r}" y="${cy - r}" width="${r * 2}" height="${r * 2}" fill="url(#scan)"/>
  </g>
  <text x="100" y="420" font-family="Georgia, 'Times New Roman', serif" font-style="italic" font-size="86" fill="#f0ece4">Observing.</text>
  <text x="104" y="486" font-family="Georgia, 'Times New Roman', serif" font-style="italic" font-size="30" fill="#f0ece4" fill-opacity="0.45">micktan.com</text>
</svg>`;
};

// ---------- shared bits ----------
const url = (slug, fill, opacity = 0.45) =>
  `<text x="104" y="560" font-family="Georgia, serif" font-style="italic" font-size="26" fill="${fill}" fill-opacity="${opacity}">micktan.com/room/${slug}</text>`;

// ---------- cooked: warm peach, vinyl, playful bold ----------
const cookedCard = () => `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <radialGradient id="warm1" cx="100%" cy="0%" r="80%">
      <stop offset="0%" stop-color="#ffe9d4"/><stop offset="60%" stop-color="#ffe9d400"/>
    </radialGradient>
    <radialGradient id="warm2" cx="0%" cy="100%" r="80%">
      <stop offset="0%" stop-color="#ffdde6"/><stop offset="55%" stop-color="#ffdde600"/>
    </radialGradient>
    <linearGradient id="vinylRing" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#ff5e7e"/><stop offset="100%" stop-color="#ff9a3e"/>
    </linearGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="#fdf3e6"/>
  <rect width="${W}" height="${H}" fill="url(#warm1)"/>
  <rect width="${W}" height="${H}" fill="url(#warm2)"/>
  <circle cx="900" cy="300" r="190" fill="#2a1a14"/>
  <circle cx="900" cy="300" r="186" fill="none" stroke="#3d2a20" stroke-width="2"/>
  <circle cx="900" cy="300" r="150" fill="none" stroke="#3d2a20" stroke-width="1.5"/>
  <circle cx="900" cy="300" r="120" fill="none" stroke="#3d2a20" stroke-width="1.5"/>
  <circle cx="900" cy="300" r="64" fill="url(#vinylRing)"/>
  <circle cx="900" cy="300" r="10" fill="#fdf3e6"/>
  <text x="100" y="330" font-family="Arial, Helvetica, sans-serif" font-weight="800" font-size="104" fill="#2a1a14">cooked.</text>
  <text x="104" y="396" font-family="Arial, Helvetica, sans-serif" font-size="34" fill="#2a1a14" fill-opacity="0.66">90s big beat song reviews.</text>
  ${url('cooked', '#2a1a14')}
</svg>`;

// ---------- corporatelardder: dark arcade, chromatic title, pixel ladder ----------
const ladderCard = () => {
  let rungs = '';
  for (let i = 0; i < 6; i++) {
    const s = 44;
    const x = 820 + i * 52;
    const y = 470 - i * 58;
    rungs += `<rect x="${x}" y="${y}" width="${s}" height="${s}" fill="none" stroke="#4af1ff" stroke-width="4" opacity="${0.35 + i * 0.11}"/>`;
  }
  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <pattern id="crt" width="4" height="4" patternUnits="userSpaceOnUse">
      <rect width="4" height="1.5" fill="rgba(255,255,255,0.03)"/>
    </pattern>
  </defs>
  <rect width="${W}" height="${H}" fill="#0a0e23"/>
  <rect width="${W}" height="${H}" fill="url(#crt)"/>
  ${rungs}
  <text x="103" y="303" font-family="'Courier New', monospace" font-weight="700" font-size="78" fill="#ff4ad9" opacity="0.85">corporatelardder.</text>
  <text x="97" y="297" font-family="'Courier New', monospace" font-weight="700" font-size="78" fill="#4af1ff" opacity="0.85">corporatelardder.</text>
  <text x="100" y="300" font-family="'Courier New', monospace" font-weight="700" font-size="78" fill="#f6e7ff">corporatelardder.</text>
  <text x="104" y="366" font-family="'Courier New', monospace" font-size="30" fill="#c0aee6">log workouts to climb the corporate lardder.</text>
  ${url('corporateladder', '#c0aee6', 0.7)}
</svg>`;
};

// ---------- papercut: cyan desk, pixel heart ----------
const papercutCard = () => {
  // pixel heart on an 8px grid, drawn as filled cells
  const cells = [
    [1,0],[2,0],[5,0],[6,0],
    [0,1],[3,1],[4,1],[7,1],
    [0,2],[7,2],
    [0,3],[7,3],
    [1,4],[6,4],
    [2,5],[5,5],
    [3,6],[4,6],
  ];
  const s = 34, ox = 860, oy = 180;
  const heart = cells.map(([x, y]) =>
    `<rect x="${ox + x * s}" y="${oy + y * s}" width="${s - 2}" height="${s - 2}" fill="#d9415f"/>`).join('');
  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
  <rect width="${W}" height="${H}" fill="#5da3c4"/>
  ${heart}
  <text x="100" y="320" font-family="'Courier New', monospace" font-weight="700" font-size="96" fill="#f7f0dc">papercut.</text>
  <text x="104" y="388" font-family="'Courier New', monospace" font-size="30" fill="#f7f0dc" fill-opacity="0.78">tamagotchi for creative worker.</text>
  <text x="104" y="428" font-family="'Courier New', monospace" font-size="30" fill="#f7f0dc" fill-opacity="0.78">feed them exposure.</text>
  ${url('papercut', '#f7f0dc', 0.6)}
</svg>`;
};

// ---------- mos: parchment, REJECTED stamp ----------
const mosCard = () => `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
  <rect width="${W}" height="${H}" fill="#f2ecd6"/>
  <ellipse cx="880" cy="475" rx="26" ry="38" fill="#3a2e1a" opacity="0.5" transform="rotate(-12 880 475)"/>
  <ellipse cx="960" cy="430" rx="26" ry="38" fill="#3a2e1a" opacity="0.7" transform="rotate(14 960 430)"/>
  <text x="100" y="310" font-family="Georgia, 'Times New Roman', serif" font-weight="500" font-size="120" fill="#2a1f10">MOS.</text>
  <text x="104" y="378" font-family="Georgia, 'Times New Roman', serif" font-style="italic" font-size="34" fill="#3a2e1a" fill-opacity="0.66">ministry of silly. walk.</text>
  <g transform="rotate(9 880 200)">
    <rect x="670" y="140" width="430" height="110" fill="none" stroke="#b22222" stroke-width="8" opacity="0.88"/>
    <text x="880" y="214" text-anchor="middle" font-family="Georgia, serif" font-weight="700" font-size="52" letter-spacing="8" fill="#b22222" opacity="0.88">REJECTED</text>
  </g>
  ${url('mos', '#3a2e1a')}
</svg>`;

// ---------- domsday: light product, accent bar, progress ----------
const domsdayCard = () => `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="acc" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="#f97316"/><stop offset="100%" stop-color="#fbbf24"/>
    </linearGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="#fafaf7"/>
  <rect x="0" y="0" width="14" height="${H}" fill="url(#acc)"/>
  <text x="100" y="300" font-family="Arial, Helvetica, sans-serif" font-weight="800" font-size="88" fill="#0e0e0c">domsday machine.</text>
  <text x="104" y="366" font-family="Arial, Helvetica, sans-serif" font-size="34" fill="#55554f">no pain no gain.</text>
  <rect x="104" y="440" width="700" height="10" rx="5" fill="#ececea"/>
  <rect x="104" y="440" width="420" height="10" rx="5" fill="url(#acc)"/>
  <text x="826" y="452" font-family="Arial, Helvetica, sans-serif" font-size="22" fill="#8a8a82">week 7 of 12</text>
  ${url('domsday', '#55554f', 0.7)}
</svg>`;

// ---------- ssb: clean zinc, blue rising bars ----------
const ssbCard = () => {
  const bars = [60, 96, 132, 176, 220].map((h, i) =>
    `<rect x="${860 + i * 62}" y="${470 - h}" width="42" height="${h}" fill="#2563eb" opacity="${0.45 + i * 0.13}"/>`).join('');
  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
  <rect width="${W}" height="${H}" fill="#f7f7f8"/>
  ${bars}
  <line x1="840" y1="470" x2="1180" y2="470" stroke="#d4d4d8" stroke-width="2"/>
  <text x="100" y="300" font-family="Arial, Helvetica, sans-serif" font-weight="800" font-size="92" fill="#09090b">SSB calculator.</text>
  <text x="104" y="366" font-family="Arial, Helvetica, sans-serif" font-size="34" fill="#52525b">work out SSB yields and payouts.</text>
  ${url('ssb', '#52525b', 0.8)}
</svg>`;
};

mkdirSync('public/og', { recursive: true });
const jobs = [
  ['public/og.png', homeCard()],
  ['public/og/cooked.png', cookedCard()],
  ['public/og/corporateladder.png', ladderCard()],
  ['public/og/papercut.png', papercutCard()],
  ['public/og/mos.png', mosCard()],
  ['public/og/domsday.png', domsdayCard()],
  ['public/og/ssb.png', ssbCard()],
];
for (const [file, svg] of jobs) {
  await sharp(Buffer.from(svg)).png().toFile(file);
  console.log('wrote', file);
}
