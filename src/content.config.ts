import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

const rooms = defineCollection({
  loader: glob({ pattern: '**/*.{md,mdx}', base: './src/content/rooms' }),
  schema: z.object({
    title: z.string(),
    summary: z.string().optional(),
    date: z.coerce.date().optional(),
    draft: z.boolean().optional().default(false),
  }),
});

export const collections = { rooms };
