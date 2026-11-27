# Staging deployment (one Ubuntu VPS)

One Ubuntu server (any VPS provider) runs the whole stack with Docker Compose (ADR-0014,
ADR-0021): Caddy (HTTPS) → Next.js → API, plus the worker, PostgreSQL and Redis on an internal
network. For trying the platform, not for production. Files: `infra/deploy/`.

Commands marked **(your computer)** run in a terminal on your own computer. Commands marked
**(server)** run over SSH on the VPS.

## 1. Get a server

Rent a VPS from any provider, in a region close to your users:

- **Ubuntu Server 24.04 LTS** (or a newer LTS), x86-64;
- at least **2 vCPU, 4 GB memory, 40 GB disk** (building the image needs about 4 GB of memory);
- a **fixed public IPv4 address** (most VPS plans include one; the certificate is issued for it);
- SSH key login: add your public key when creating the server (or with `ssh-copy-id`).

If the provider has its own firewall in its control panel, allow inbound TCP 22, 80 and 443 and
UDP 443 (port 80 is needed for certificate issuance and redirects to HTTPS).

Connect (**your computer**; the provider shows the first user, often `root` or `ubuntu`):

```bash
ssh ubuntu@203.0.113.10
```

Costs: the provider's monthly price for the plan, plus any backup storage (§7). Check current prices on the provider's site.

## 2. Prepare the server (server)

If you connected as `root`, create a normal user with sudo, copy your SSH key to it, and
continue as that user:

```bash
adduser acf && usermod -aG sudo acf && rsync --archive --chown=acf:acf ~/.ssh /home/acf
```

Updates, the time zone (the nightly backup runs at 02:15 server time; UTC is assumed below),
and automatic security updates:

```bash
sudo apt-get update && sudo apt-get -y upgrade && sudo apt-get install -y git openssl curl rclone unattended-upgrades
```

```bash
sudo timedatectl set-timezone UTC
```

Key-only SSH (only after you have checked that key login works for your user):

```bash
printf 'PasswordAuthentication no\nPermitRootLogin no\n' | sudo tee /etc/ssh/sshd_config.d/90-acf.conf && sudo systemctl reload ssh
```

Firewall (UFW): SSH, HTTP and HTTPS only. Only Caddy publishes ports; Docker's own rules bypass
UFW for published ports, so nothing else in the compose file is published.

```bash
sudo ufw allow OpenSSH && sudo ufw allow 80/tcp && sudo ufw allow 443/tcp && sudo ufw allow 443/udp && sudo ufw --force enable
```

Install Docker Engine with the Compose plugin (Docker's official install script):

```bash
curl -fsSL https://get.docker.com | sudo sh
```

```bash
sudo usermod -aG docker "$USER"
```

Log out and in again (`exit`, then `ssh …`) so the group applies. Add 4 GB of swap for the
build:

```bash
sudo fallocate -l 4G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile && echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

Get the code. A private repository needs credentials: use a fine-grained GitHub token with
read-only access to this repository when git asks for a password (never store it in the repo).

```bash
git clone https://github.com/dungld96/content-factory.git && cd content-factory
```

```bash
git checkout claude/gracious-planck-kuf4pq
```

## 3. Configure (server)

Choose the site address:

- your own domain: create a DNS `A` record pointing to the server's IP first, then use the
  domain (e.g. `acf.example.com`);
- no domain: use `<IP>.sslip.io` (e.g. `203.0.113.10.sslip.io`), a public DNS name that resolves
  to the IP.

```bash
infra/deploy/generate-env.sh 203.0.113.10.sslip.io
```

It writes `infra/deploy/.env.production` (random passwords and secrets, mode 600, git-ignored).
Never commit or share it; back it up somewhere private (it holds the database passwords).

## 4. Build, migrate, start (server)

```bash
cd infra/deploy
```

```bash
./acf.sh build migrate
```

```bash
./acf.sh up -d postgres redis seaweedfs
```

```bash
./acf.sh run --rm migrate
```

Create the asset bucket in SeaweedFS (idempotent):

```bash
./acf.sh run --rm storage-setup
```

Create your own account (the password is read from the terminal). Projects, content and voice
profiles are then created in the web UI:

```bash
./acf.sh run --rm -it -w /app/apps/api migrate node dist/cli/user-cli.js create --email you@example.com --name "Your Name"
```

Optional demo workspace instead (Demo Studio, three demo users; passwords are printed once):

```bash
./acf.sh run --rm -w /app/apps/api -e NODE_ENV=development migrate node dist/cli/seed.js
```

```bash
./acf.sh up -d
```

```bash
./acf.sh ps
```

Open `https://<site address>/login`. Caddy obtains the certificate on the first request (a few
seconds). Logs: `./acf.sh logs -f api worker web caddy`.

Check that the image's FFmpeg (Debian 5.1, not the 6.1 used in development) renders correctly:
it renders two short synthetic videos (the standard mix with captions, music and loudness
normalisation, and one with audio layers: voice offset, clip audio, music fades and mute, a sound
effect), runs the automated QC on both and prints the result (exit code 0 = both passed; no
network, no cost):

```bash
./acf.sh run --rm -w /app worker node packages/media/dist/selftest-cli.js
```

## 5. Real model (OpenRouter, paid)

To manage providers, models and routes in **Settings → AI providers & models** instead of the CLI
below, add your account to `OPERATOR_EMAILS=you@example.com` in `infra/deploy/.env.production`
and restart the API (`./acf.sh up -d api`). The key itself is only ever set in that file.

Without a provider key, generation answers "No usable model for this task". To use OpenRouter,
set `OPENROUTER_API_KEY=` in `infra/deploy/.env.production` (on the server only), then:

```bash
./acf.sh up -d api worker
```

To use MixRoute as well (P5), set `MIXROUTE_API_KEY=` the same way and restart the API and
worker. The seed registers the `mixroute` gateway and its curated models disabled: enable the
gateway and the models you reviewed in Settings › AI, then move steps with **Switch gateway**.

Routes measured in the M8 pilot (`docs/design/m8/pilot-report.md`): scripts Gemini 3.5 Flash
Lite, storyboards **Claude Haiku 5.5** (Gemini did not keep to the clip lengths), keyframes
Seedream 5.0 Flash, clips Veo 3.1 Lite; narration is chosen per voice profile (MAI-Voice 2.1 has
native Vietnamese voices, e.g. `vi-VN-Harper:MAI-Voice-2.1`).

```bash
./acf.sh exec api node dist/cli/ai-registry-cli.js model set-status google/gemini-3.5-flash-lite enabled
```

```bash
./acf.sh exec api node dist/cli/ai-registry-cli.js model set-status anthropic/claude-haiku-5.5 enabled
```

```bash
./acf.sh exec api node dist/cli/ai-registry-cli.js route set script_generation google/gemini-3.5-flash-lite
```

```bash
./acf.sh exec api node dist/cli/ai-registry-cli.js route set storyboard_generation anthropic/claude-haiku-5.5
```

Storyboards are written to fit the routed clip model's lengths: no retiming is needed when
the video route is set before storyboards are generated. Optional, for Gemini on structured tasks:
`./acf.sh exec api node dist/cli/ai-registry-cli.js model set-schema-mode google/gemini-3.5-flash-lite basic`.

Image, video and TTS models are imported disabled (`model import-openrouter-images|videos|tts`,
see LOCAL_DEVELOPMENT.md); enable and route the ones above the same way
(`route set image_generation bytedance-seed/seedream-5-0-flash`,
`route set video_generation google/veo-3.1-lite`). A 30 s video costs about USD 1.05 with these
routes; the default project budget (USD 10 per month) allows about nine.

If the provider was seeded as `disabled` (no key at seed time), enable it too:
`./acf.sh exec api node dist/cli/ai-registry-cli.js provider set-status openrouter enabled` (see
`docs/LOCAL_DEVELOPMENT.md` for the registry commands). Every call's reported cost is recorded
per job.

## 6. Operate (server)

Users (passwords are read from the terminal, never from arguments):

```bash
./acf.sh exec api node dist/cli/user-cli.js set-password --email editor@demo.acf.test
```

Update to a newer commit (take a backup first; migrations run in `migrate` and are forward-only):

```bash
./acf.sh backup
```

```bash
git pull && ./acf.sh build migrate && ./acf.sh run --rm migrate && ./acf.sh up -d
```

Rollback: there are no down-migrations. To return to an earlier version, restore the backup taken
before the update onto fresh volumes with the earlier commit checked out (`git checkout <commit>`,
`./acf.sh build migrate`, then the restore steps in §7).

After every deploy (a few minutes, no cost):

1. `./acf.sh ps`: every service `running`/`healthy`.
2. `https://<site address>/status`: database and Redis `ok`.
3. Media self-test: `./acf.sh run --rm -w /app worker node packages/media/dist/selftest-cli.js`.
4. Sign in, open **Operations**: queues reachable, no failed jobs you do not expect, circuits closed.
5. Response headers include `Strict-Transport-Security` and `X-Frame-Options`
   (`curl -sI https://<site address>/login`).

Asset files live in the `seaweedfs-data` volume on the server's disk; provider snapshots of the
disk (if your VPS plan offers them) back them up together with the database volume.

## 7. Backup and restore

ADR-0020, ADR-0021.

A backup is the database dump plus every stored object with a SHA-256 manifest, in
`infra/deploy/backups/<UTC timestamp>/`. It can run while the stack is up; the last 7 are kept on
the server. It contains user data and password hashes: keep it private. Secrets
(`.env.production`) are not included; keep your own private copy of that file.

```bash
./acf.sh backup
```

### Scheduled, off-server backups

A backup on the server's own disk does not survive losing the server. Once, give the server a
place to copy backups to, then schedule the nightly backup. The copy uses
[rclone](https://rclone.org), so the destination can be any S3-compatible object storage
(most VPS providers sell one; also Backblaze B2, Cloudflare R2, Wasabi), or a second server over
SFTP. Use a bucket or folder **only for these backups**: copies older than the retention period
are deleted there.

Create the destination at your storage provider (a private bucket and an access key limited to
it, or an SSH login on the other server), then add it on the server as an rclone remote named
`offsite`. `rclone config` is interactive: choose **n** (new remote), name `offsite`, then the
type (`s3` with your provider and its endpoint, `b2`, or `sftp`) and the key. It stores them in
`~/.config/rclone/rclone.conf` (mode 600, outside the repository); the key never goes into the
shell history or `.env.production`.

```bash
rclone config
```

Check it:

```bash
rclone lsd offsite:YOUR_BACKUP_BUCKET
```

Name the destination and schedule the backup (02:15 every night, server time):

```bash
cd ~/content-factory/infra/deploy && printf 'BACKUP_REMOTE=offsite:YOUR_BACKUP_BUCKET/acf\nBACKUP_REMOTE_KEEP_DAYS=30\n' >> .env.production
```

```bash
./acf.sh backup-schedule install
```

Each night the backup is checked and copied to `offsite:YOUR_BACKUP_BUCKET/acf/<timestamp>/` (the
`backup.json` manifest last, so a copy with `backup.json` is complete). Then copies there older
than `BACKUP_REMOTE_KEEP_DAYS` (default 30) are deleted, and local backups beyond the last 7. A
failed backup or copy removes nothing and writes a line with `"event":"backup_failed"` to
`backups/backup.log`. Check it, and the destination, the next morning:

```bash
./acf.sh backup-schedule status
```

```bash
rclone lsd offsite:YOUR_BACKUP_BUCKET/acf
```

`./acf.sh backup-schedule remove` removes the schedule. Without `BACKUP_REMOTE` the schedule
still runs and keeps the last 7 backups on the server only.

To restore on a new server, set up the same rclone remote there, copy one backup back first,
then restore as below:

```bash
rclone copy offsite:YOUR_BACKUP_BUCKET/acf/<timestamp> backups/<timestamp>
```

### Restore

Restore needs **empty volumes** (a new server, or after `./acf.sh down -v`, which deletes all data):
it restores the database, writes the objects back, checks every object and asset checksum, and
applies any newer migrations. Then start the stack.

```bash
./acf.sh restore <timestamp>
```

```bash
./acf.sh up -d
```

### Stop or remove

Stop the stack (data is kept in Docker volumes):

```bash
./acf.sh down
```

When you no longer need the server, take a last backup and copy it off the server, then cancel
or delete the server in your provider's control panel (this deletes its disk and all data).

## 8. Budgets, alerts and operations

Every project starts with a monthly budget of USD 10 (hard), USD 3 per content item (soft) and USD
2 per request (hard); owners change them on the project's **Costs** page. Defaults for new projects
come from `DEFAULT_MONTHLY_BUDGET_USD`, `DEFAULT_ITEM_BUDGET_USD` and `DEFAULT_REQUEST_BUDGET_USD`.

**Cost confirmation (redesign R-D4).** A paid action whose estimate is above the workspace's
cost-confirmation threshold (USD 1 until an operator changes it in **Settings › Budgets &
spending**), or whose price is unknown, asks before it runs; owners can set a project's own
threshold on its Costs page.

**Live updates (ADR-0022).** Browsers follow jobs over `GET /api/v1/events` (Server-Sent
Events). Caddy flushes event streams as they come; if a proxy in front of Caddy buffers them, the
studio falls back to polling by itself. After a deploy, open a content item, start a generation
and check that the top bar's **Jobs** tray says **Live**.

The **Operations** page (sidebar) shows queues, failed jobs (with **Resume**), provider circuits,
budgets and held reservations. A held reservation is a provider call whose outcome is unknown:
check the provider's dashboard or invoice, then record it as **Charged** or **Not charged**.

Logs are one JSON object per line (`LOG_JSON=true`). Alert on these `msg` values with any log
shipper, e.g. `./acf.sh logs -f api worker | grep -E '"msg":"(budget_exceeded|circuit_opened|job_dead_lettered|reservation_held)"'`:

| `msg` | Service | Meaning |
|---|---|---|
| `budget_exceeded` | api, worker | A request (API) or a queued job (worker re-check) was refused by a hard limit. |
| `budget_threshold` | api | A project reached 80 % of its monthly budget (used + reserved). |
| `circuit_opened` / `circuit_closed` | worker | A provider failed 5 times in 10 min; work waits and retries. / It recovered. |
| `job_dead_lettered` | worker | A job failed after all retries (shown on the Operations page). |
| `reservation_held` | worker | A provider call's charge is unknown; an owner must resolve it. |
| `reconciler_requeued` | worker | Queue state was repaired after a restart or a Redis loss. |
| `backup_failed` (`event`, in `infra/deploy/backups/backup.log`) | backup.sh | A scheduled backup or its off-server copy failed; nothing was removed. `./acf.sh backup-schedule status` shows the last failure. |

Circuits can also be inspected or forced from the server:

```bash
./acf.sh exec api node dist/cli/ai-registry-cli.js circuit list
```

```bash
./acf.sh exec api node dist/cli/ai-registry-cli.js circuit close openrouter
```

## 9. Security notes

- Only Caddy publishes ports (80/443). PostgreSQL, Redis, SeaweedFS and the API are internal;
  browsers read asset bytes only through the API (`GET /assets/:assetId/content`).
- `NODE_ENV=production`: `Secure` `__Host-` cookies; `TRUST_PROXY` names only the web and Caddy
  containers; Caddy replaces client-sent `X-Forwarded-*` headers.
- Each container receives only the variables it needs; the admin and migrator database URLs go
  only to the one-off `migrate` tool, and the storage admin key only to `storage-setup`. The
  OpenRouter and storage keys never reach the browser.
- SSH access is by key only (password and root login disabled, §2); UFW allows only SSH, HTTP
  and HTTPS; unattended-upgrades installs Ubuntu security updates.
