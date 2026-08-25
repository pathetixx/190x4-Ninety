// Ninety · отбор серверов для подменю трея.
//
// Контекстное меню не заменяет экран Серверы: на подписке в три сотни нод оно
// нечитаемо, а каждый пункт несёт иконку флага, которую Windows держит
// отдельным объектом. Меню пересобирается на каждое переключение ноды, так
// что цена этих иконок платится снова и снова — поэтому список обрезаем.

export const TRAY_SERVER_LIMIT = 24;

// Порядок: текущая нода, затем избранные, затем всё остальное в порядке
// подписки. Внутри группы порядок исходного списка сохраняется, чтобы меню не
// перетасовывалось между пересборками.
export function pickTrayServers(entries, favourites, limit = TRAY_SERVER_LIMIT) {
  if (!Array.isArray(entries)) return [];
  if (entries.length <= limit) return entries;
  const isFavourite = (id) => {
    try { return favourites?.has?.(id) === true; } catch { return false; }
  };
  const rank = (entry) => (entry?.selected ? 0 : isFavourite(entry?.id) ? 1 : 2);
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => rank(a.entry) - rank(b.entry) || a.index - b.index)
    .slice(0, limit)
    .map(({ entry }) => entry);
}
