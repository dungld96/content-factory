-- M6: render jobs (own migration: PostgreSQL cannot use an enum value in the transaction that adds it).
ALTER TYPE "generation_job_kind" ADD VALUE 'render';
