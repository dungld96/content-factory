# Staging deployment (Google Cloud, one VM)

One Compute Engine VM runs the whole stack with Docker Compose (ADR-0014): Caddy (HTTPS) →
Next.js → API, plus the worker, PostgreSQL and Redis on an internal network. For trying the
platform, not for production. Files: `infra/deploy/`.

Commands marked **(your computer)** need the Google Cloud CLI (`gcloud`) signed in to your
project. Commands marked **(VM)** run over SSH on the VM.

## 1. Create the VM (your computer)

Pick a region close to your users (here Singapore). Set your project once:

```bash
gcloud config set project YOUR_PROJECT_ID
```

```bash
gcloud services enable compute.googleapis.com
```

Reserve a static IP so the address (and the certificate) survive restarts:

```bash
gcloud compute addresses create acf-staging-ip --region=asia-southeast1
```

```bash
gcloud compute addresses describe acf-staging-ip --region=asia-southeast1 --format='value(address)'
```

Allow HTTP and HTTPS to VMs tagged `acf-web` (port 80 is needed for certificate issuance and
redirects to HTTPS):

```bash
gcloud compute firewall-rules create acf-allow-web --allow=tcp:80,tcp:443,udp:443 --target-tags=acf-web
```

Create the VM (2 vCPU, 4 GB; building the image needs about 4 GB of memory):

```bash
gcloud compute instances create acf-staging --zone=asia-southeast1-b --machine-type=e2-medium --image-family=debian-12 --image-project=debian-cloud --boot-disk-size=30GB --tags=acf-web --address=acf-staging-ip
```

```bash
gcloud compute ssh acf-staging --zone=asia-southeast1-b
```

Costs: an e2-medium VM, its disk and the static IP are billed while they exist (the IP also
while the VM is stopped). Check current prices with the Google Cloud pricing calculator.

## 2. Prepare the VM (VM)

Install Docker Engine with the Compose plugin (Docker's official install script), git and
openssl:

```bash
sudo apt-get update && sudo apt-get install -y git openssl curl
```

```bash
curl -fsSL https://get.docker.com | sudo sh
```

```bash
sudo usermod -aG docker "$USER"
```

Log out and in again (`exit`, then `gcloud compute ssh …`) so the group applies. Add 4 GB of swap
for the build:

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

## 3. Configure (VM)

Choose the site address:

- your own domain: create a DNS `A` record pointing to the static IP first, then use the
  domain (e.g. `acf.example.com`);
- no domain: use `<IP>.sslip.io` (e.g. `34.1.2.3.sslip.io`), a public DNS name that resolves
  to the IP.

```bash
infra/deploy/generate-env.sh 34.1.2.3.sslip.io
```

It writes `infra/deploy/.env.production` (random passwords and secrets, mode 600, git-ignored).
Never commit or share it; back it up somewhere private (it holds the database passwords).

## 4. Build, migrate, start (VM)

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

Create the asset bucket in SeaweedFS (M4a; idempotent):

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

Check that the image's FFmpeg (Debian 5.1, not the 6.1 used in development) renders correctly
(M6 risk R6): it renders a short synthetic video with captions, music and loudness normalisation,
runs the automated QC and prints the result (exit code 0 = passed; no network, no cost):

```bash
./acf.sh run --rm -w /app worker node packages/media/dist/selftest-cli.js
```

## 5. Real model (OpenRouter, paid)

Without a provider key, generation answers "No usable model for this task". To use OpenRouter,
set `OPENROUTER_API_KEY=` in `infra/deploy/.env.production` (on the VM only), then:

```bash
./acf.sh up -d api worker
```

Routes measured in the M8 pilot (`docs/design/m8/pilot-report.md`): scripts Gemini 3.5 Flash
Lite, storyboards **Claude Haiku 5.5** (Gemini rejects the storyboard's JSON schema), keyframes
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

Image, video and TTS models are imported disabled (`model import-openrouter-images|videos|tts`,
see LOCAL_DEVELOPMENT.md); enable and route the ones above the same way
(`route set image_generation bytedance-seed/seedream-5-0-flash`,
`route set video_generation google/veo-3.1-lite`). A 30 s video costs about USD 1.05 with these
routes; the default project budget (USD 10 per month) allows about nine.

If the provider was seeded as `disabled` (no key at seed time), enable it too:
`./acf.sh exec api node dist/cli/ai-registry-cli.js provider set-status openrouter enabled` (see
`docs/LOCAL_DEVELOPMENT.md` for the registry commands). Every call's reported cost is recorded
per job.

## 6. Operate (VM)

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

Upgrade notes by milestone (all migrations are applied by `migrate`; nothing else is needed unless
listed): M4a needs storage keys (below); M6 needs `media:selftest` after the first build; M7 adds
budgets for every existing project (USD 10/3/2, change them on the Costs page) and optional
`DEFAULT_*_BUDGET_USD` variables; M8 adds the `backup` tool service and security headers in Caddy.

Rollback: there are no down-migrations. To return to an earlier version, restore the backup taken
before the update onto fresh volumes with the earlier commit checked out (`git checkout <commit>`,
`./acf.sh build migrate`, then the restore steps in "Backup and restore").

After every deploy (a few minutes, no cost):

1. `./acf.sh ps`: every service `running`/`healthy`.
2. `https://<site address>/status`: database and Redis `ok`.
3. Media self-test: `./acf.sh run --rm -w /app worker node packages/media/dist/selftest-cli.js`.
4. Sign in, open **Operations**: queues reachable, no failed jobs you do not expect, circuits closed.
5. Response headers include `Strict-Transport-Security` and `X-Frame-Options`
   (`curl -sI https://<site address>/login`).

Upgrading a deployment created before M4a: `.env.production` has no storage keys yet. Append them
once (then run `./acf.sh up -d seaweedfs` and `./acf.sh run --rm storage-setup` before the full
`up -d`):

```bash
printf 'S3_ACCESS_KEY_ID=acf_app_%s\nS3_SECRET_ACCESS_KEY=%s\nSTORAGE_ADMIN_ACCESS_KEY_ID=acf_admin_%s\nSTORAGE_ADMIN_SECRET_ACCESS_KEY=%s\n' "$(openssl rand -hex 6)" "$(openssl rand -hex 24)" "$(openssl rand -hex 6)" "$(openssl rand -hex 24)" >> .env.production
```

Asset files live in the `seaweedfs-data` volume on the VM's persistent disk; disk snapshots
back them up together with the database volume.

#### Backup and restore (M8, ADR-0020)

A backup is the database dump plus every stored object with a SHA-256 manifest, in
`infra/deploy/backups/<UTC timestamp>/`. It can run while the stack is up; the last 7 are kept.
It contains user data and password hashes: keep it private. Secrets (`.env.production`) are not
included; keep your own private copy of that file.

```bash
./acf.sh backup
```

Copy backups off the VM (replace the bucket with yours):

```bash
gcloud storage cp -r infra/deploy/backups/<timestamp> gs://<your-backup-bucket>/acf/
```

Nightly at 02:15 UTC (optional; add with `crontab -e` on the VM, adjusting the path):

```bash
15 2 * * * cd /home/$USER/content-factory/infra/deploy && ./acf.sh backup >> backups/backup.log 2>&1
```

Restore needs **empty volumes** (a new VM, or after `./acf.sh down -v`, which deletes all data):
it restores the database, writes the objects back, checks every object and asset checksum, and
applies any newer migrations. Then start the stack.

```bash
./acf.sh restore <timestamp>
```

```bash
./acf.sh up -d
```

Stop the stack (data is kept in Docker volumes):

```bash
./acf.sh down
```

Stop paying for compute when not in use (your computer); the disk and static IP are still
billed:

```bash
gcloud compute instances stop acf-staging --zone=asia-southeast1-b
```

Remove everything (your computer; deletes the VM, its disk and all data):

```bash
gcloud compute instances delete acf-staging --zone=asia-southeast1-b
```

```bash
gcloud compute addresses delete acf-staging-ip --region=asia-southeast1
```

### Budgets, alerts and operations (M7)

Every project starts with a monthly budget of USD 10 (hard), USD 3 per content item (soft) and USD
2 per request (hard); owners change them on the project's **Costs** page. Defaults for new projects
come from `DEFAULT_MONTHLY_BUDGET_USD`, `DEFAULT_ITEM_BUDGET_USD` and `DEFAULT_REQUEST_BUDGET_USD`.

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

Circuits can also be inspected or forced from the VM:

```bash
./acf.sh exec api node dist/cli/ai-registry-cli.js circuit list
```

```bash
./acf.sh exec api node dist/cli/ai-registry-cli.js circuit close openrouter
```

## Security notes

- Only Caddy publishes ports (80/443). PostgreSQL, Redis, SeaweedFS and the API are internal;
  browsers read asset bytes only through the API (`GET /assets/:assetId/content`).
- `NODE_ENV=production`: `Secure` `__Host-` cookies; `TRUST_PROXY` names only the web and Caddy
  containers; Caddy replaces client-sent `X-Forwarded-*` headers.
- Each container receives only the variables it needs; the admin and migrator database URLs go
  only to the one-off `migrate` tool, and the storage admin key only to `storage-setup`. The
  OpenRouter and storage keys never reach the browser.
- SSH access is through `gcloud compute ssh` (Google identity); no password login.
