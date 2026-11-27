import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, existsSync, openSync, readFileSync } from 'node:fs';
import { appendFile, chmod, copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { Readable } from 'node:stream';
import {
  JobOfferSchema,
  PROTOCOL_VERSION,
  TargetSchema,
  UpdateManifestSchema,
  type JobOffer,
} from '../../packages/contracts/dist/index.js';
import {
  createHarness,
  resetDatabase,
  seedProject,
  seedUser,
  type Harness,
} from '../../apps/api/test/harness.js';
import { bindRunner, seedRunner, signManifest } from '../../apps/api/test/release-helpers.js';
import type { ArtifactSource } from '../../apps/api/src/services/release-artifacts.js';
import { openMigrationDatabase, runMigrations } from '../../apps/api/src/db/migrate.js';

const required = (name: string): string => {
  const value = process.env[name];
  if (value === undefined || value === '') throw new Error(`${name} is required`);
  return value;
};

const databaseUrl = required('TEST_DATABASE_URL');
const work = required('E2E_WORK');
const artifactsDir = required('E2E_ARTIFACTS_DIR');
const oldBinary = required('E2E_OLD_BIN');
const newBinary = required('E2E_NEW_BIN');
const target = required('E2E_TARGET');
const evidencePath = required('E2E_EVIDENCE');
const corruptArchive = required('E2E_CORRUPT_ARCHIVE');
const manifestPath = required('E2E_MANIFEST');
const signaturePath = required('E2E_SIGNATURE');
const scenarios = required('E2E_SCENARIOS').split(',').map((name) => name.trim());
const deferTimeoutMs = Number(process.env.E2E_DEFER_TIMEOUT_SECS ?? '420') * 1000;
const publishToken = 'e2e-release-publish-token-0123456789';

const tokenPath = join(work, 'token');
const configPath = join(work, 'config.toml');
const repositoryPath = join(work, 'workspace');
const exePath = join(work, 'runner');
const previousPath = `${exePath}.prev`;
const stateDir = work;

const evidence: string[] = [];
const note = (line: string): void => {
  evidence.push(line);
  console.log(line);
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const check = (condition: boolean, message: string): void => {
  if (!condition) throw new Error(`assertion failed: ${message}`);
  note(`- PASS ${message}`);
};

async function waitFor<T>(
  label: string,
  probe: () => Promise<T | null | undefined | false> | T | null | undefined | false,
  timeoutMs: number,
  intervalMs = 100,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== null && value !== undefined && value !== false) return value as T;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for ${label}`);
    await sleep(intervalMs);
  }
}

const sha256File = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex');

const hostArchiveName = (version: string): string =>
  `intentra-runner-${version}-${target}${target === 'x86_64-pc-windows-msvc' ? '.zip' : '.tar.gz'}`;

class LocalArtifactSource implements ArtifactSource {
  readonly calls: string[] = [];
  readonly singleUse = new Set<string>();
  private readonly served = new Set<string>();

  constructor(private readonly directory: string) {}

  async open(url: string, _signal: AbortSignal): Promise<Readable> {
    const fileName = basename(new URL(url).pathname);
    this.calls.push(fileName);
    const path = join(this.directory, fileName);
    if (!existsSync(path)) throw new Error(`offline artifact source has no ${fileName}`);
    if (this.singleUse.has(fileName) && this.served.has(fileName)) {
      throw new Error(`offline artifact source serves ${fileName} once`);
    }
    this.served.add(fileName);
    return createReadStream(path);
  }
}

const sha256Hex = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

function signedManifest(version: string, archivePath: string): { manifest: string; signature: string } {
  const archive = readFileSync(archivePath);
  const assets = TargetSchema.options.map((assetTarget) => {
    const fileName = `intentra-runner-${version}-${assetTarget}${assetTarget === 'x86_64-pc-windows-msvc' ? '.zip' : '.tar.gz'}`;
    return {
      target: assetTarget,
      fileName,
      url: `https://github.com/MaximenkovAnton/intentra/releases/download/v${version}/${fileName}`,
      sizeBytes: archive.length,
      sha256: sha256Hex(archive),
    };
  });
  const manifest = UpdateManifestSchema.parse({
    schemaVersion: 1,
    version,
    channel: 'stable',
    protocolVersion: PROTOCOL_VERSION,
    publishedAt: new Date().toISOString(),
    notes: `e2e ${version}`,
    assets,
  });
  return signManifest(manifest);
}

const tamperSignature = (signature: string): string =>
  `${signature.startsWith('A') ? 'B' : 'A'}${signature.slice(1)}`;

interface RunnerHandle {
  readonly child: ChildProcess;
  readonly exited: Promise<number | null>;
  readonly logPath: string;
}

let harness: Harness | null = null;
let source: LocalArtifactSource;
let runner: Awaited<ReturnType<typeof seedRunner>> | null = null;
let current: RunnerHandle | null = null;
let lastLogPath = '';
let port = 0;

const center = (): string => `http://127.0.0.1:${port}`;

async function post(path: string, body: unknown, token?: string): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token !== undefined) headers.authorization = `Bearer ${token}`;
  const response = await fetch(`${center()}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
  const parsed: unknown = await response.json().catch(() => null);
  return { status: response.status, body: parsed };
}

const publish = (manifest: string, signature: string): Promise<{ status: number; body: unknown }> =>
  post('/api/admin/releases', { manifest, signature }, publishToken);

const yank = (version: string): Promise<{ status: number; body: unknown }> =>
  post(`/api/admin/releases/${version}/yank`, { yanked: true }, publishToken);

const errorCode = (body: unknown): string | null =>
  typeof body === 'object' && body !== null && 'code' in body && typeof body.code === 'string'
    ? body.code
    : null;

async function runnerVersion(): Promise<string> {
  if (runner === null) return '';
  const result = await pool().query<{ version: string }>('SELECT version FROM runners WHERE id = $1', [runner.runner.id]);
  return result.rows[0]?.version ?? '';
}

const pool = (): NonNullable<Harness['pool']> => {
  if (harness === null) throw new Error('the centre is not ready');
  return harness.pool;
};

interface UpdateEvent {
  readonly fromVersion: string;
  readonly toVersion: string;
  readonly status: string;
  readonly reason: string | null;
}

async function updateEvents(): Promise<UpdateEvent[]> {
  if (runner === null) return [];
  const result = await pool().query<{ from_version: string; to_version: string; status: string; reason: string | null }>(
    'SELECT from_version, to_version, status, reason FROM runner_update_events WHERE runner_id = $1 ORDER BY created_at DESC',
    [runner.runner.id],
  );
  return result.rows.map((row) => ({
    fromVersion: row.from_version,
    toVersion: row.to_version,
    status: row.status,
    reason: row.reason,
  }));
}

async function releaseRow(version: string): Promise<{ version: string } | undefined> {
  const result = await pool().query<{ version: string }>('SELECT version FROM releases WHERE version = $1', [version]);
  return result.rows[0];
}

const runnerLog = (): string => {
  const logPath = current?.logPath ?? lastLogPath;
  return logPath === '' || !existsSync(logPath) ? '' : readFileSync(logPath, 'utf8');
};

function runnerLogTail(lines = 30): string {
  const text = runnerLog()
    .split('\n')
    .filter((line) => line.trim() !== '')
    .slice(-lines)
    .join('\n');
  return text === '' ? '(runner log is empty)' : text;
}

function git(args: string[]): void {
  const result = spawnSync('git', args, { cwd: repositoryPath, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
}

async function prepareWorkspace(): Promise<void> {
  await mkdir(repositoryPath, { recursive: true });
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 'runner@example.test']);
  git(['config', 'user.name', 'Intentra E2E']);
  await writeFile(join(repositoryPath, '.gitignore'), '.intentra/\n');
  await writeFile(join(repositoryPath, 'README.md'), 'e2e workspace\n');
  git(['add', '.']);
  git(['commit', '-q', '-m', 'initial']);
}

async function writeRunnerConfig(token: string, runnerId: string): Promise<void> {
  await writeFile(tokenPath, JSON.stringify({ runnerId, token }), { mode: 0o600 });
  await chmod(tokenPath, 0o600);
  const config = `server_url = "ws://127.0.0.1:${port}/api/runners/ws"
token_path = "${tokenPath}"
allow_roots = ["${repositoryPath}"]
log_level = "info"
max_concurrent_jobs = 1

[workspaces]
p = "${repositoryPath}"

[runtimes.cli]
binary = "sh"
args = ["-c", "sleep 900"]

[update]
enabled = true
channel = "stable"
check_interval_min = 5
allow_insecure_http = true
`;
  await writeFile(configPath, config);
}

async function stopRunner(signal: NodeJS.Signals = 'SIGTERM', timeoutMs = 8000): Promise<void> {
  const running = current;
  if (running === null) return;
  current = null;
  running.child.kill(signal);
  const outcome = await Promise.race([running.exited, sleep(timeoutMs).then(() => 'timeout' as const)]);
  if (outcome === 'timeout') {
    running.child.kill('SIGKILL');
    await running.exited;
  }
  if (runner !== null) {
    await waitFor('the centre sees the runner offline', () => !harness.app.orchestrator.hub.online(runner!.runner.id), 5000, 50).catch(
      () => undefined,
    );
  }
}

async function startRunner(binary: string, expectedVersion: string, requireOnline = true): Promise<RunnerHandle> {
  await stopRunner();
  await copyFile(binary, `${exePath}.next`);
  await chmod(`${exePath}.next`, 0o755);
  await rename(`${exePath}.next`, exePath);
  const logPath = join(work, `runner-${randomUUID()}.log`);
  const logFd = openSync(logPath, 'a');
  const child = spawn(exePath, ['start', '--config', configPath], {
    env: {
      ...process.env,
      INTENTRA_UPDATE_PUBKEY: required('E2E_TEST_PUBKEY'),
      RUST_LOG: 'info',
    },
    stdio: ['ignore', logFd, logFd],
  });
  const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
  const handle: RunnerHandle = { child, exited, logPath };
  current = handle;
  lastLogPath = logPath;
  note(`- started ${binary} as ${exePath} (pid ${child.pid ?? 'unknown'}), waiting for hello ${expectedVersion}`);
  const connected = (): boolean =>
    readFileSync(logPath, 'utf8').includes('runner connected') ||
    (runner !== null && harness.app.orchestrator.hub.online(runner.runner.id));
  await waitFor('the runner connects to the centre', connected, 30000, 50);
  if (requireOnline && runner !== null) {
    await waitFor(
      'the centre sees the runner websocket',
      () => harness.app.orchestrator.hub.online(runner!.runner.id),
      30000,
      50,
    );
  }
  await waitFor(`the runner reports ${expectedVersion} in hello`, async () => (await runnerVersion()) === expectedVersion, 30000, 100);
  note(`- the centre recorded hello ${expectedVersion}`);
  return handle;
}

async function publishGeneratedRelease(): Promise<void> {
  const manifest = await readFile(manifestPath, 'utf8');
  const signature = (await readFile(signaturePath, 'utf8')).trim();
  const result = await publish(manifest, signature);
  check(result.status === 201, `the release API stores the generated 0.2.0 release (HTTP ${result.status})`);
}

async function ensureCorruptRelease(): Promise<void> {
  if ((await releaseRow('0.3.0')) !== undefined) return;
  const signed = signedManifest('0.3.0', corruptArchive);
  const result = await publish(signed.manifest, signed.signature);
  check(result.status === 201, `the release API stores the 0.3.0 release with a valid signature (HTTP ${result.status})`);
}

async function scenarioHappyPath(): Promise<void> {
  note('## Scenario: happy path 0.1.0 -> 0.2.0 (no jobs)');
  await publishGeneratedRelease();
  const newSha = sha256File(newBinary);
  const oldSha = sha256File(oldBinary);
  await startRunner(oldBinary, '0.1.0');
  await waitFor('the centre records the hello of the updated runner', async () => (await runnerVersion()) === '0.2.0', 60000, 100);
  note('- the centre recorded a second hello with 0.2.0');
  const applied = await waitFor(
    'the runner reports the applied update',
    async () => (await updateEvents()).find((event) => event.status === 'applied' && event.toVersion === '0.2.0'),
    30000,
    100,
  );
  check(applied.fromVersion === '0.1.0', `the applied report goes 0.1.0 -> 0.2.0 (got ${applied.fromVersion} -> ${applied.toVersion})`);
  check(sha256File(exePath) === newSha, 'the binary on disk is the 0.2.0 artifact');
  check(existsSync(previousPath) && sha256File(previousPath) === oldSha, 'the .prev backup is the previous 0.1.0 binary');
  const version = spawnSync(exePath, ['--version'], { encoding: 'utf8' });
  check(version.status === 0 && version.stdout.includes('0.2.0'), `the updated binary reports --version 0.2.0 (${version.stdout.trim()})`);
  check(
    source.calls.filter((call) => call === hostArchiveName('0.2.0')).length === 1,
    `the runner downloaded the 0.2.0 artifact exactly once (${source.calls.join(', ')})`,
  );
  note(`- artifacts downloaded: ${source.calls.join(', ')}`);
  await stopRunner();
}

async function scenarioBadSignature(): Promise<void> {
  note('## Scenario: the centre and the runner refuse a forged signature');
  const signed = signedManifest('0.2.1', corruptArchive);
  const forged = tamperSignature(signed.signature);
  const rejected = await publish(signed.manifest, forged);
  check(rejected.status === 400, `the centre rejects the forged signature with HTTP 400 (got ${rejected.status})`);
  check(errorCode(rejected.body) === 'VALIDATION', `the error code is VALIDATION (got ${String(errorCode(rejected.body))})`);
  check((await releaseRow('0.2.1')) === undefined, 'the rejected release is not stored');
  await pool().query(
    'INSERT INTO releases (version, channel, protocol_version, manifest, signature, notes, published_at) VALUES ($1, $2, $3, $4, $5, $6, $7)',
    ['0.2.1', 'stable', PROTOCOL_VERSION, signed.manifest, forged, 'e2e forged signature', new Date()],
  );
  note('- inserted a 0.2.1 release with a forged signature directly into the channel');
  await startRunner(newBinary, '0.2.0');
  const failed = await waitFor(
    'the runner reports the rejected signature',
    async () => (await updateEvents()).find((event) => event.status === 'failed' && event.toVersion === '0.2.1'),
    30000,
    100,
  );
  check(failed.reason?.includes('signature') === true, `the failure names the signature (reason: ${failed.reason ?? 'none'})`);
  check((await runnerVersion()) === '0.2.0', 'the runner still reports 0.2.0 after the forged manifest');
  check(sha256File(exePath) === sha256File(newBinary), 'the forged manifest did not replace the binary');
  check(
    source.calls.every((call) => call !== hostArchiveName('0.2.1')),
    'the runner refused the signature before downloading the artifact',
  );
  await stopRunner();
}

async function scenarioDeferWhileBusy(): Promise<void> {
  note('## Scenario: the update is deferred while a job is active');
  if (runner === null) throw new Error('the runner is not seeded');
  await startRunner(newBinary, '0.2.0');
  const jobId = randomUUID();
  const offer: JobOffer = JobOfferSchema.parse({
    type: 'job.offer',
    jobId,
    intentId: randomUUID(),
    stage: 'build',
    runtime: 'cli',
    payload: { projectKey: 'p', task: 'e2e', intentShort: 'e2e', prompt: '' },
    leaseUntil: new Date(Date.now() + 600_000).toISOString(),
  });
  check(harness.app.orchestrator.hub.sendOffer(runner.runner.id, offer), 'the centre sends a job offer to the runner');
  const worktree = join(repositoryPath, '.intentra', 'worktrees', jobId);
  await waitFor('the runner starts the slow job', () => existsSync(worktree), 20000, 100);
  note('- the runner started the slow job and holds the update gate');
  await ensureCorruptRelease();
  note('- published the 0.3.0 release while the job is running');
  await waitFor(
    'the runner defers the next update check while the job is active',
    () => runnerLog().includes('deferring the update check while a job is active'),
    deferTimeoutMs,
    250,
  );
  note('- the runner logged the deferred update check');
  check(
    source.calls.every((call) => call !== hostArchiveName('0.3.0')),
    'the deferred check did not download the 0.3.0 artifact',
  );
  check((await runnerVersion()) === '0.2.0', 'the runner is still 0.2.0 after the deferred check');
  check(
    (await updateEvents()).every((event) => event.toVersion !== '0.3.0'),
    'no update report for 0.3.0 was sent while the job is active',
  );
  check(existsSync(worktree), 'the job is still active at the end of the deferred check');
  note(`- runner log: ${runnerLog().split('\n').filter((line) => line.includes('deferring')).slice(-1).join('')}`);
  await stopRunner();
}

async function scenarioRollback(): Promise<void> {
  note('## Scenario: a broken binary is rolled back to .prev');
  await ensureCorruptRelease();
  const newSha = sha256File(newBinary);
  source.singleUse.add(hostArchiveName('0.3.0'));
  await startRunner(newBinary, '0.2.0', false);
  const rolledBack = await waitFor(
    'the runner reports rolled_back for the broken 0.3.0',
    async () => (await updateEvents()).find((event) => event.status === 'rolled_back' && event.toVersion === '0.3.0'),
    45000,
    50,
  );
  await stopRunner('SIGKILL', 3000);
  const yanked = await yank('0.3.0');
  check(yanked.status === 204, `the centre yanks the broken release (HTTP ${yanked.status})`);
  check(sha256File(exePath) === newSha, 'the runner binary on disk is the previous 0.2.0 binary');
  check(existsSync(previousPath) && sha256File(previousPath) === newSha, '.prev holds the 0.2.0 binary the rollback restored');
  check(
    rolledBack.reason?.includes('could not restart') === true,
    `the rollback reason names the failed restart (reason: ${rolledBack.reason ?? 'none'})`,
  );
  check(rolledBack.fromVersion === '0.2.0', `the rollback report goes 0.2.0 -> 0.3.0 (got ${rolledBack.fromVersion} -> ${rolledBack.toVersion})`);
  const state: unknown = JSON.parse(readFileSync(join(stateDir, 'update-state.json'), 'utf8'));
  const pending =
    typeof state === 'object' && state !== null && 'pending' in state ? state.pending : undefined;
  check(pending === null || pending === undefined, 'the rollback cleared the pending update from update-state.json');
  check(
    source.calls.filter((call) => call === hostArchiveName('0.3.0')).length >= 1,
    'the runner did download the broken 0.3.0 artifact before the rollback',
  );
  note(`- artifacts downloaded: ${source.calls.join(', ')}`);
}

async function migrate(): Promise<void> {
  const migration = openMigrationDatabase(databaseUrl);
  try {
    await runMigrations(migration.db);
  } finally {
    await migration.pool.end();
  }
}

async function main(): Promise<void> {
  await migrate();
  source = new LocalArtifactSource(artifactsDir);
  harness = await createHarness(
    { LOG_LEVEL: 'warn', RELEASE_PUBLISH_TOKEN: publishToken },
    { releaseArtifactSource: source, releaseCacheDir: join(work, 'release-cache') },
  );
  await resetDatabase(harness.db);
  const owner = await seedUser(harness.db);
  const project = await seedProject(harness.db, owner.id);
  runner = await seedRunner(harness.db, { ownerUserId: owner.id, version: '0.1.0' });
  await bindRunner(harness.db, project.id, runner.runner.id);
  await harness.app.listen({ host: '127.0.0.1', port: 0 });
  const address = harness.app.server.address();
  if (address === null || typeof address !== 'object') throw new Error('the centre has no TCP address');
  port = address.port;
  note(`- the real centre app listens on http://127.0.0.1:${port} (database ${databaseUrl})`);
  note(`- seeded runner ${runner.runner.id} bound to project ${project.key}`);
  for (const path of [
    tokenPath,
    configPath,
    exePath,
    `${exePath}.next`,
    previousPath,
    join(work, 'update-state.json'),
    join(work, 'state.json'),
    join(work, 'release-cache'),
    repositoryPath,
  ]) {
    await rm(path, { recursive: true, force: true });
  }
  await prepareWorkspace();
  await writeRunnerConfig(runner.token, runner.runner.id);
  note(`- workspace ${repositoryPath}; runner token ${tokenPath}; config ${configPath}`);

  const suite: Record<string, () => Promise<void>> = {
    happy: scenarioHappyPath,
    'bad-signature': scenarioBadSignature,
    defer: scenarioDeferWhileBusy,
    rollback: scenarioRollback,
  };
  for (const name of scenarios) {
    const scenario = suite[name];
    if (scenario === undefined) throw new Error(`unknown scenario ${name}; expected ${Object.keys(suite).join(', ')}`);
    await scenario();
  }
  note('');
  note('All assertions passed.');
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  note(`- FAIL ${message}`);
  note('');
  note('```');
  note(runnerLogTail());
  note('```');
  console.error(`e2e-update: ${message}`);
  process.exitCode = 1;
} finally {
  await stopRunner('SIGKILL', 3000).catch(() => undefined);
  if (harness !== null) {
    await harness.close().catch(() => undefined);
  }
  await appendFile(evidencePath, `${evidence.join('\n')}\n`).catch(() => undefined);
}
