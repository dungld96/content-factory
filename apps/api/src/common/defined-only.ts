/** Removes `undefined` properties, so partial PATCH input can be passed to Prisma under
 * `exactOptionalPropertyTypes` (an absent key means "leave unchanged"; `null` still clears). */
export type DefinedOnly<T> = { [K in keyof T]?: Exclude<T[K], undefined> };

export function definedOnly<T extends object>(value: T): DefinedOnly<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, v]) => v !== undefined),
  ) as DefinedOnly<T>;
}
