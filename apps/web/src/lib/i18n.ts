/**
 * Interface strings (UX review U8): English today; every new or reworked component reads its
 * text through `t()`, so Vietnamese can be added as a second dictionary without touching
 * components. Placeholders: `{name}`.
 */
const EN = {
  'nav.workspace': 'Workspace',
  'nav.production': 'Production',
  'nav.workspaceSettings': 'Workspace settings',
  'nav.overview': 'Overview',
  'nav.projects': 'Projects',
  'nav.content': 'Content library',
  'nav.masters': 'Content masters',
  'nav.pipeline': 'Production pipeline',
  'nav.assets': 'Asset library',
  'nav.operations': 'Operations',
  'nav.settings': 'Settings',
  'nav.menu': 'Menu',
  'nav.openMenu': 'Open the menu',
  'nav.closeMenu': 'Close the menu',
  'nav.library': 'Library',
  'nav.contentShort': 'Content',
  'search.placeholder': 'Search content…',
  'search.label': 'Search content',
} as const;

export type MessageKey = keyof typeof EN;

const DICTIONARIES: Readonly<Record<string, Readonly<Record<MessageKey, string>>>> = { en: EN };

/** The text for `key` in the interface language, with `{placeholders}` filled in. */
export function t(key: MessageKey, vars: Readonly<Record<string, string | number>> = {}): string {
  const text = (DICTIONARIES['en'] ?? EN)[key];
  return text.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in vars ? String(vars[name]) : match,
  );
}
