import { Prisma } from '@acf/database';

/**
 * Static SQL identifiers for one versioned brand entity (characters or environments share
 * one schema shape; ADR-0010). Values are compile-time constants, never user input, so
 * `Prisma.raw` is safe here.
 */
export interface VersionedKind {
  readonly key: 'character' | 'environment';
  /** Human label used in messages ("character"). */
  readonly label: string;
  readonly parentTable: Prisma.Sql;
  readonly versionTable: Prisma.Sql;
  readonly linkTable: Prisma.Sql;
  /** FK column on the version table pointing at the parent (`character_id`). */
  readonly parentFk: Prisma.Sql;
  /** FK column on the link table pointing at the version (`character_version_id`). */
  readonly linkFk: Prisma.Sql;
  /** JSONB rules column (`identity_rules` / `visual_rules`). */
  readonly rulesColumn: Prisma.Sql;
}

const id = (name: string) => Prisma.raw(`"${name}"`);

export const CHARACTER_KIND: VersionedKind = {
  key: 'character',
  label: 'character',
  parentTable: id('characters'),
  versionTable: id('character_versions'),
  linkTable: id('character_version_assets'),
  parentFk: id('character_id'),
  linkFk: id('character_version_id'),
  rulesColumn: id('identity_rules'),
};

export const ENVIRONMENT_KIND: VersionedKind = {
  key: 'environment',
  label: 'environment',
  parentTable: id('environments'),
  versionTable: id('environment_versions'),
  linkTable: id('environment_version_assets'),
  parentFk: id('environment_id'),
  linkFk: id('environment_version_id'),
  rulesColumn: id('visual_rules'),
};
