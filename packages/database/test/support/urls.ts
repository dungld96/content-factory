/** Name of the disposable integration-test database (recreated on every run). */
export const TEST_DATABASE_NAME = 'acf_test';

export interface TestDatabaseUrls {
  /** Superuser: create/drop databases only. */
  readonly adminUrl: string;
  /** Schema owner (acf_migrator) on the test database: migrations, cleanup (TRUNCATE). */
  readonly migratorUrl: string;
  /** Runtime role (acf_app) on the test database: DML only. */
  readonly appUrl: string;
}
