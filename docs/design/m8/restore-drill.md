# M8a restore drill (2026-11-20)

`scripts/backup-drill.sh` (same commands as `infra/deploy/backup.sh`) run in the development
environment with `DRILL_DB=acf_test_e2e DRILL_BUCKET=acf-test-e2e`: the E2E run's database and
bucket, which hold real generated images, clips, voice-overs and renders.

| Step                                         | Result                                                                                         |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `pg_dump --format=custom` (PostgreSQL 17.12) | ok                                                                                             |
| Object export                                | 368 objects, 7 909 024 bytes, manifest with SHA-256                                            |
| `pg_restore --exit-on-error` into a new DB   | ok                                                                                             |
| Object import into a new bucket              | 368 written, 0 already present                                                                 |
| Row counts, every table                      | 43 tables identical                                                                            |
| Migrations in the restored database          | 16 recorded                                                                                    |
| Verify (deep)                                | files = manifest; bucket = manifest (checksums); all 20 asset rows present with their checksum |

A first run against the development database stopped at the last check, correctly: its demo
reference asset was seeded before object storage existed (metadata only, `apps/api/src/cli/seed.ts`),
so its row has no object. Restores of real deployments seeded with storage do not have such rows;
the verify reports any that do.

Not drilled here: `acf.sh restore` itself on the VM (the deployment image cannot be built in this
environment). The UAT script (M8d) includes one backup and restore on staging.
