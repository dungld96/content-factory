import 'server-only';

import { cookies } from 'next/headers';

/** The theme the user picked in the sidebar (`acf_theme` cookie); `null` follows the system. */
export async function getTheme(): Promise<'light' | 'dark' | null> {
  const value = (await cookies()).get('acf_theme')?.value;
  return value === 'light' || value === 'dark' ? value : null;
}
