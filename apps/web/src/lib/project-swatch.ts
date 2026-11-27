/**
 * A stable colour and initials per project (design canvas: the coloured square beside a project
 * name). Projects have no colour of their own; the swatch is derived from the id.
 */
const SWATCHES = ['#d9a441', '#c77dab', '#6f8fd8', '#5fae8b', '#d9785b', '#8c7ad9', '#4fa3b5'];

export function projectSwatch(projectId: string): string {
  let hash = 0;
  for (const ch of projectId) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return SWATCHES[hash % SWATCHES.length] ?? '#d9a441';
}

export function projectInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const letters =
    words.length > 1 ? `${words[0]?.[0] ?? ''}${words[1]?.[0] ?? ''}` : name.slice(0, 2);
  return letters.toUpperCase();
}
