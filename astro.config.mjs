// @ts-check
import { defineConfig } from 'astro/config';

import tailwindcss from '@tailwindcss/vite';

import vercel from '@astrojs/vercel';

// https://astro.build/config
export default defineConfig({
  vite: {
    plugins: [tailwindcss()]
  },

  // The carousel engine lived at /carousel before it became a room.
  redirects: {
    '/carousel': '/room/carousel/',
  },

  adapter: vercel()
});