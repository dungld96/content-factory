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

Optional demo workspace (Demo Studio, three demo users; passwords are printed once — the web UI
cannot yet create projects or content items, so this is the easiest way to try it):

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

## 5. Real model (OpenRouter, paid)

Without a provider key, generation answers "No usable model for this task". To use OpenRouter,
set `OPENROUTER_API_KEY=` in `infra/deploy/.env.production` (on the VM only), then:

```bash
./acf.sh up -d api worker
```

```bash
./acf.sh exec api node dist/cli/ai-registry-cli.js model set-status google/gemini-3.5-flash-lite enabled
```

```bash
./acf.sh exec api node dist/cli/ai-registry-cli.js route set script_generation google/gemini-3.5-flash-lite
```

```bash
./acf.sh exec api node dist/cli/ai-registry-cli.js route set storyboard_generation google/gemini-3.5-flash-lite
```

If the provider was seeded as `disabled` (no key at seed time), enable it too:
`./acf.sh exec api node dist/cli/ai-registry-cli.js provider set-status openrouter enabled` (see
`docs/LOCAL_DEVELOPMENT.md` for the registry commands). Every call's reported cost is recorded
per job.

## 6. Operate (VM)

Users (passwords are read from the terminal, never from arguments):

```bash
./acf.sh exec api node dist/cli/user-cli.js set-password --email editor@demo.acf.test
```

Update to a newer commit:

```bash
git pull && ./acf.sh build migrate && ./acf.sh run --rm migrate && ./acf.sh up -d
```

Upgrading a deployment created before M4a: `.env.production` has no storage keys yet. Append them
once (then run `./acf.sh up -d seaweedfs` and `./acf.sh run --rm storage-setup` before the full
`up -d`):

```bash
printf 'S3_ACCESS_KEY_ID=acf_app_%s\nS3_SECRET_ACCESS_KEY=%s\nSTORAGE_ADMIN_ACCESS_KEY_ID=acf_admin_%s\nSTORAGE_ADMIN_SECRET_ACCESS_KEY=%s\n' "$(openssl rand -hex 6)" "$(openssl rand -hex 24)" "$(openssl rand -hex 6)" "$(openssl rand -hex 24)" >> .env.production
```

Asset files live in the `seaweedfs-data` volume on the VM's persistent disk; disk snapshots
back them up together with the database volume.

Back up the database (store the file privately; it contains user data and password hashes):

```bash
./acf.sh exec -T postgres pg_dump -U acf acf > "acf-$(date -u +%Y%m%d).sql"
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

## Security notes

- Only Caddy publishes ports (80/443). PostgreSQL, Redis, SeaweedFS and the API are internal;
  browsers read asset bytes only through the API (`GET /assets/:assetId/content`).
- `NODE_ENV=production`: `Secure` `__Host-` cookies; `TRUST_PROXY` names only the web and Caddy
  containers; Caddy replaces client-sent `X-Forwarded-*` headers.
- Each container receives only the variables it needs; the admin and migrator database URLs go
  only to the one-off `migrate` tool, and the storage admin key only to `storage-setup`. The
  OpenRouter and storage keys never reach the browser.
- SSH access is through `gcloud compute ssh` (Google identity); no password login.
