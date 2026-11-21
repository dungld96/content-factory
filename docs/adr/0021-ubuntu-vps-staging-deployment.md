# ADR-0021: Staging on a generic Ubuntu VPS (no cloud-specific tooling)

- Status: Accepted (owner request, 2026-11-20). Supersedes the Google Cloud parts of ADR-0014.
- Date: 2026-11-20
- Milestone: none (deployment target change after M8.5)

## Context

ADR-0014 put staging on one Google Cloud Compute Engine VM: the deployment guide used `gcloud`
for the VM, static IP and firewall, and M8.5 (Q9) copied nightly backups to Cloud Storage with
`gcloud storage` and the VM's service account. The owner wants no dependency on Google Cloud:
staging should run on an ordinary Ubuntu VPS from any provider.

The application stack itself was never cloud-specific: Docker Compose, Caddy, PostgreSQL,
Redis, SeaweedFS and the deploy image (Debian-based container) run unchanged on any Linux host.

## Decision

1. **Target: one Ubuntu Server LTS VPS** (24.04 or newer, x86-64, ≥ 2 vCPU, 4 GB memory,
   40 GB disk, fixed public IPv4), any provider. The single-server Docker Compose topology of
   ADR-0014 is unchanged.
2. **Server setup uses only standard Ubuntu tools** (DEPLOYMENT.md §1–2): a sudo user with SSH
   key login, password and root SSH login disabled, UFW allowing SSH/HTTP/HTTPS,
   unattended-upgrades, UTC time zone, swap for the build, Docker's official install script.
   The provider's own firewall, if any, is configured in its control panel.
3. **Off-server backups use rclone** instead of `gcloud storage`: `BACKUP_REMOTE=<remote>:<path>`
   in `.env.production` names an rclone remote (any S3-compatible storage, Backblaze B2, or
   SFTP to another server) configured with `rclone config`; its credentials stay in
   `~/.config/rclone/rclone.conf`, outside the repository and `.env.production`. Order and
   guarantees of M8.5 Q9 are kept: data first, `backup.json` last; no local pruning after a
   failed copy; one `backup_failed` line per failure. Retention at the destination is done by
   the script (`rclone delete --min-age <BACKUP_REMOTE_KEEP_DAYS>d`, default 30), not by a
   provider lifecycle rule, so it works on every backend; the destination must hold only these
   backups.
4. `BACKUP_GCS_BUCKET` is removed (it was never deployed: the bucket had not been named).

## Consequences

- No Google Cloud account, CLI or IAM setup is needed; the guide works with any VPS provider.
- Static IP, firewall and snapshots are the provider's features and are described generically.
- rclone (Ubuntu package) is a new host dependency, installed in DEPLOYMENT.md §2; tested with a
  stub in `infra/deploy/backup.test.ts` and once end to end against a local rclone remote.
- Historical design packages and ADR-0014 keep their Google Cloud wording as records.
