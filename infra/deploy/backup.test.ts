import { execFile } from 'node:child_process';
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// M8.5 Q9: off-server copy, pruning only after a successful copy, the `backup_failed` line and the
// cron schedule. backup.sh runs from a scratch copy of infra/deploy with stub `rclone` and
// `crontab` on PATH that record their calls; no Docker, remote storage or real crontab is touched.
const run = promisify(execFile);
const source = import.meta.dirname;

let work: string;
let deploy: string;
let bin: string;

async function stub(name: string, body: string): Promise<void> {
  const file = path.join(bin, name);
  await writeFile(file, `#!/usr/bin/env bash\n${body}\n`);
  await chmod(file, 0o755);
}

async function makeBackup(name: string): Promise<void> {
  const dir = path.join(deploy, 'backups', name);
  await mkdir(path.join(dir, 'storage'), { recursive: true });
  await writeFile(path.join(dir, 'database.dump'), 'dump');
  await writeFile(path.join(dir, 'storage', 'objects.json'), '[]');
  await writeFile(path.join(dir, 'backup.json'), '{"format":"acf-backup/1"}');
}

async function backupSh(args: string[], env: Record<string, string> = {}) {
  try {
    const { stdout, stderr } = await run(path.join(deploy, 'backup.sh'), args, {
      env: { PATH: `${bin}:/usr/bin:/bin`, HOME: work, CALLS: path.join(work, 'calls'), ...env },
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const e = error as { code: number; stdout: string; stderr: string };
    return { code: e.code, stdout: e.stdout, stderr: e.stderr };
  }
}

const calls = async () =>
  (await readFile(path.join(work, 'calls'), 'utf8').catch(() => '')).trim().split('\n');
const local = async () => (await readdir(path.join(deploy, 'backups'))).sort();

beforeEach(async () => {
  work = await mkdtemp(path.join(tmpdir(), 'acf-backup-test-'));
  deploy = path.join(work, 'deploy');
  bin = path.join(work, 'bin');
  await mkdir(deploy);
  await mkdir(bin);
  await copyFile(path.join(source, 'backup.sh'), path.join(deploy, 'backup.sh'));
  await copyFile(path.join(source, 'acf.sh'), path.join(deploy, 'acf.sh'));
  await chmod(path.join(deploy, 'backup.sh'), 0o755);
  await chmod(path.join(deploy, 'acf.sh'), 0o755);
  await writeFile(path.join(deploy, '.env.production'), 'POSTGRES_USER=acf\n');
  // rclone records its arguments; RCLONE_FAIL=1 makes it fail like an unreachable remote.
  await stub('rclone', 'echo "rclone $*" >> "$CALLS"; [[ "${RCLONE_FAIL:-}" != 1 ]]');
  // crontab keeps its table in $HOME/crontab.
  await stub(
    'crontab',
    'if [[ "$1" == "-l" ]]; then cat "$HOME/crontab" 2>/dev/null || exit 1; else cat > "$HOME/crontab"; fi',
  );
  for (let day = 1; day <= 9; day += 1) await makeBackup(`2026110${String(day)}T021500Z`);
});

afterEach(async () => {
  await rm(work, { recursive: true, force: true });
});

describe('backup.sh ship (off-VM copy and pruning)', () => {
  it('without a remote: keeps the last 7 local backups and calls no rclone', async () => {
    const result = await backupSh(['ship', '20261109T021500Z']);
    expect(result.code).toBe(0);
    expect(await local()).toHaveLength(7);
    expect((await local())[0]).toBe('20261103T021500Z');
    expect(await calls()).toEqual(['']);
  });

  it('with a remote: copies the data, then the manifest, then prunes both sides', async () => {
    await writeFile(
      path.join(deploy, '.env.production'),
      'POSTGRES_USER=acf\nBACKUP_REMOTE=offsite:acf-backups/\nBACKUP_REMOTE_KEEP_DAYS=14\n',
    );
    const result = await backupSh(['ship', '20261109T021500Z']);
    expect(result.code).toBe(0);
    const [data, manifest, remotePrune] = await calls();
    expect(data).toMatch(
      /^rclone copy --exclude \/backup\.json .*\/backups\/20261109T021500Z offsite:acf-backups\/20261109T021500Z$/,
    );
    expect(manifest).toMatch(
      /^rclone copyto .*\/backup\.json offsite:acf-backups\/20261109T021500Z\/backup\.json$/,
    );
    expect(remotePrune).toBe('rclone delete --min-age 14d --rmdirs offsite:acf-backups');
    expect(await local()).toHaveLength(7);
  });

  it('a failed copy prints backup_failed, exits non-zero and removes nothing', async () => {
    await writeFile(path.join(deploy, '.env.production'), 'BACKUP_REMOTE=offsite:acf-backups\n');
    const result = await backupSh(['ship', '20261109T021500Z'], { RCLONE_FAIL: '1' });
    expect(result.code).not.toBe(0);
    const line = JSON.parse(result.stderr.trim().split('\n').pop() ?? '{}') as Record<
      string,
      string
    >;
    expect(line).toMatchObject({
      event: 'backup_failed',
      stage: 'offsite',
      backup: '20261109T021500Z',
    });
    expect(await local()).toHaveLength(9);
  });

  it.each(['offsite:', 'offsite:/', 'no-colon', 'offsite:a b', 'offsite:x;rm'])(
    'refuses the remote %j without calling rclone',
    async (value) => {
      await writeFile(path.join(deploy, '.env.production'), `BACKUP_REMOTE=${value}\n`);
      const result = await backupSh(['ship', '20261109T021500Z']);
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain('"stage":"offsite-config"');
      expect(await calls()).toEqual(['']);
      expect(await local()).toHaveLength(9);
    },
  );

  it('refuses a name that is not a backup', async () => {
    const result = await backupSh(['ship', '../etc']);
    expect(result.code).not.toBe(0);
    expect(await local()).toHaveLength(9);
  });
});

describe('backup.sh backup failure', () => {
  it('prints backup_failed, removes the partial backup and prunes nothing', async () => {
    await stub('docker', 'exit 1');
    const result = await backupSh(['backup', 'tonight']);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/"event":"backup_failed".*"stage":"backup","backup":"tonight"/);
    expect(await local()).not.toContain('tonight');
    expect(await local()).toHaveLength(9);
  });
});

describe('acf.sh backup-schedule', () => {
  const tab = async () => readFile(path.join(work, 'crontab'), 'utf8').catch(() => '');

  it('installs one tagged line at 02:15, keeps other lines, and removes it again', async () => {
    await writeFile(path.join(work, 'crontab'), '0 5 * * * echo other\n');
    const acf = async (arg: string) => {
      const { stdout } = await run(path.join(deploy, 'acf.sh'), ['backup-schedule', arg], {
        env: { PATH: `${bin}:/usr/bin:/bin`, HOME: work },
      });
      return stdout;
    };
    await acf('install');
    await acf('install'); // idempotent
    const lines = (await tab()).trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe('0 5 * * * echo other');
    expect(lines[1]).toMatch(/^15 2 \* \* \* PATH=.*; cd .*\/deploy && \.\/acf\.sh backup >> /);
    expect(lines[1]).toContain('# acf-backup (M8.5)');
    expect(await acf('status')).toMatch(/^scheduled: 15 2/);

    await acf('remove');
    expect((await tab()).trim()).toBe('0 5 * * * echo other');
    expect(await acf('status')).toMatch(/^not scheduled/);
  });

  it('status reports the remote and the last failure from the log', async () => {
    await writeFile(path.join(deploy, '.env.production'), 'BACKUP_REMOTE=offsite:acf-backups\n');
    await writeFile(
      path.join(deploy, 'backups', 'backup.log'),
      '{"event":"backup_failed","at":"2026-11-19T02:15:09Z","stage":"offsite","backup":"x"}\n',
    );
    const result = await backupSh(['backup-schedule', 'status']);
    expect(result.stdout).toContain('off-server copy: offsite:acf-backups/ (kept 30 days)');
    expect(result.stdout).toContain('latest local backup:');
    expect(result.stdout).toContain('last failure: {"event":"backup_failed"');
  });
});
