import sharp from 'sharp';

const W = 1200, H = 630;
// Lens centre / radius
const cx = 840, cy = 280, r = 210;

const svg = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
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

  <!-- faint outer glow ring so the lens reads against the dark field -->
  <circle cx="${cx}" cy="${cy}" r="${r + 14}" fill="none" stroke="#f0ece4" stroke-opacity="0.08" stroke-width="28"/>

  <circle cx="${cx}" cy="${cy}" r="${r}" fill="url(#lens)"/>
  <g clip-path="url(#lensClip)">
    <rect x="${cx - r}" y="${cy - r}" width="${r * 2}" height="${r * 2}" fill="url(#scan)"/>
  </g>

  <!-- the word, cream italic serif, lower left -->
  <text x="100" y="420" font-family="Georgia, 'Times New Roman', serif" font-style="italic" font-size="86" fill="#f0ece4">Observing.</text>
  <text x="104" y="486" font-family="Georgia, 'Times New Roman', serif" font-style="italic" font-size="30" fill="#f0ece4" fill-opacity="0.45">micktan.com</text>
</svg>`;

await sharp(Buffer.from(svg)).png().toFile('public/og.png');
console.log('wrote public/og.png');
