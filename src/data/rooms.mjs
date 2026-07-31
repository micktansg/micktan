// Single source of truth for the interactive rooms.
// Plain .mjs (not .ts) so og-gen.mjs at the repo root can import it too.
//
// ORDER MATTERS: the array is newest-first. It drives
//   1. the hall listing at /room/ (top to bottom),
//   2. the next-room circuit (each room links to the item AFTER it,
//      and the last room wraps back to the first),
//   3. og-gen.mjs coverage validation (every id here must have an OG card).
//
// Adding a room = add one entry at the TOP of this array (plus the room's
// own folder). The hall, the circuit links, and the veil colors all update
// themselves. `bg` is the room's page background — it doubles as the exit-veil
// color other pages fade through when navigating INTO the room, and as the
// browser themeColor.

export const interactiveRooms = [
  {
    id: 'ctrl-s',
    title: 'ctrl-s.',
    summary: "save points you can't load.",
    date: '2026-08-01',
    bg: '#efe7d8',
  },
  {
    id: 'ssb',
    title: 'SSB calculator.',
    summary: 'work out SSB yields and payouts.',
    date: '2026-05-16',
    bg: '#f7f7f8',
  },
  {
    id: 'domsday',
    title: 'domsday machine.',
    summary: 'no pain no gain.',
    date: '2026-05-08',
    bg: '#fafaf7',
  },
  {
    id: 'mos',
    title: 'MOS.',
    summary: 'ministry of silly. walk.',
    date: '2026-05-01',
    bg: '#f2ecd6',
  },
  {
    id: 'papercut',
    title: 'papercut.',
    summary: 'tamagotchi for creative worker. feed them exposure.',
    date: '2026-05-01',
    bg: '#5da3c4',
  },
  {
    id: 'corporateladder',
    title: 'corporatelardder.',
    summary: 'log workouts to climb the corporate lardder.',
    date: '2026-05-01',
    bg: '#0a0e23',
  },
  {
    id: 'cooked',
    title: 'cooked.',
    summary: '90s big beat song reviews.',
    date: '2026-04-30',
    bg: '#fdf3e6',
  },
];

export const roomHref = (id) => `/room/${id}/`;

// The circuit: next room in hall order, looping at the end.
export const nextRoom = (id) => {
  const idx = interactiveRooms.findIndex((r) => r.id === id);
  if (idx === -1) throw new Error(`[rooms.mjs] unknown room id "${id}" — add it to the manifest`);
  const next = interactiveRooms[(idx + 1) % interactiveRooms.length];
  return { ...next, href: roomHref(next.id) };
};
