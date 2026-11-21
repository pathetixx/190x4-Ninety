// Ninety · layout of the "Server" submenu in the tray.
//
// A flat list works while there are a dozen servers. On a subscription of two or three hundred
// it turns into a strip down to the edge of the screen in which nothing can be found, and the menu
// is rebuilt on every node switch — and every flag icon in it
// is paid for anew. So a big list is laid out by country: at the top
// the current server, favorites and the fastest, below — countries with counts,
// within a country nodes by ascending latency.

// Below this number there's nothing to group: a country with one node is an extra click.
export const TRAY_FLAT_LIMIT = 12;
// The ceiling of nodes within one country. Providers like to keep dozens of nodes in
// one location, but choosing from thirty in a menu is already uncomfortable.
export const TRAY_GROUP_LIMIT = 30;
// The ceiling for the whole submenu. Windows builds the menu entirely, and each item
// costs a kernel object, so the list must have an end.
export const TRAY_TOTAL_LIMIT = 180;
export const TRAY_FAVOURITE_LIMIT = 12;
export const TRAY_FAST_LIMIT = 8;

const OTHER_GROUP = "\u0000other";

function byDelayThenOrder(a, b) {
  const ad = Number(a?.delay) > 0 ? Number(a.delay) : Infinity;
  const bd = Number(b?.delay) > 0 ? Number(b.delay) : Infinity;
  if (ad !== bd) return ad - bd;
  return (a?.index ?? 0) - (b?.index ?? 0);
}

function isFavourite(favourites, id) {
  try { return favourites?.has?.(id) === true; } catch { return false; }
}

/**
 * Lays out the node list into the submenu structure.
 *
 * @param {Array<{id: string, label: string, iso: string|null, selected: boolean, delay: number|null}>} entries
 * @param {{favourites?: Set<string>, countryLabel?: (iso: string) => string, otherLabel?: string}} opts
 * @returns {{current: object|null, flat: object[], favourites: object[], fast: object[],
 *            groups: Array<{iso: string|null, label: string, items: object[], hidden: number}>,
 *            hidden: number, total: number}}
 */
export function buildTrayServerMenu(entries, opts = {}) {
  const list = Array.isArray(entries) ? entries : [];
  const indexed = list.map((entry, index) => ({ ...entry, index }));
  const current = indexed.find(e => e.selected) || null;
  const base = {
    current, flat: [], favourites: [], fast: [], groups: [],
    hidden: 0, total: indexed.length,
  };
  if (indexed.length === 0) return base;

  // A small subscription: grouping only gets in the way — we return the list as is.
  if (indexed.length <= TRAY_FLAT_LIMIT) {
    return { ...base, flat: indexed };
  }

  const favourites = indexed
    .filter(e => !e.selected && isFavourite(opts.favourites, e.id))
    .slice(0, TRAY_FAVOURITE_LIMIT);

  // "Fastest" is built only from actually measured nodes: without a measurement the word
  // "fast" is a promise nobody made.
  const fast = indexed
    .filter(e => !e.selected && Number(e.delay) > 0)
    .sort(byDelayThenOrder)
    .slice(0, TRAY_FAST_LIMIT);

  const buckets = new Map();
  for (const entry of indexed) {
    const key = entry.iso || OTHER_GROUP;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(entry);
  }

  const countryLabel = typeof opts.countryLabel === "function" ? opts.countryLabel : (iso => iso || "");
  const currentKey = current ? (current.iso || OTHER_GROUP) : null;
  const groups = Array.from(buckets.entries())
    .map(([key, items]) => ({
      key,
      iso: key === OTHER_GROUP ? null : key,
      label: key === OTHER_GROUP ? (opts.otherLabel || "") : countryLabel(key),
      items: items.slice().sort(byDelayThenOrder),
      count: items.length,
    }))
    .sort((a, b) => {
      // The current server's country goes first: it's returned to most often.
      if (a.key === currentKey && b.key !== currentKey) return -1;
      if (b.key === currentKey && a.key !== currentKey) return 1;
      // Nodes without a country go at the very bottom: these are the provider's service entries.
      if (a.iso === null && b.iso !== null) return 1;
      if (b.iso === null && a.iso !== null) return -1;
      if (a.count !== b.count) return b.count - a.count;
      return a.label.localeCompare(b.label);
    });

  const shown = [];
  let budget = TRAY_TOTAL_LIMIT;
  let hidden = 0;
  for (const group of groups) {
    const take = Math.max(0, Math.min(group.items.length, TRAY_GROUP_LIMIT, budget));
    const items = group.items.slice(0, take);
    budget -= items.length;
    hidden += group.count - items.length;
    // The whole group didn't fit — its nodes are already counted in hidden, and the group itself
    // must not be an empty line in the menu.
    if (items.length > 0) {
      shown.push({ iso: group.iso, label: group.label, items, hidden: group.count - items.length });
    }
  }

  return { current, flat: [], favourites, fast, groups: shown, hidden, total: indexed.length };
}
