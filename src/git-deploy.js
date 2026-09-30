import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
export const DATE_RE = /^\d{8}$/; // YYYYMMDD, strictly — this becomes a branch name, so it's also our injection guard
const STEP_TIMEOUT_MS = 10 * 60 * 1000;

export class DeployError extends Error {
  constructor(message, log = []) {
    super(message);
    this.log = log;
  }
}

// Local date, not UTC — a bare /deploy before 07:00 in WIB (UTC+7) must not
// target yesterday's release.
export function today(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
}

/**
 * fetch --all -> reset local phi-dev to <pushRemote>/phi-dev -> merge
 * release/<date> -> push -> dotnet ef update.
 *
 * Uses execFile (argv array, no shell) throughout, so even an unvalidated
 * date couldn't break out into shell syntax — the regex check is about
 * correctness, not injection.
 */
export async function deploy({ repoDir, releaseRemote, pushRemote, efArgs, dateArg }) {
  const date = dateArg ?? today();
  if (!DATE_RE.test(date)) {
    throw new DeployError(`bad date "${date}", expected YYYYMMDD`);
  }

  const branch = `release/${date}`;
  const opts = {
    cwd: repoDir,
    timeout: STEP_TIMEOUT_MS,
    env: {
      ...process.env,
      // No TTY under launchd/schtasks — a credential prompt must fail fast,
      // not hang until the step timeout while holding the deploy lock.
      GIT_TERMINAL_PROMPT: '0',
      GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND || 'ssh -o BatchMode=yes',
    },
  };
  const log = [];

  async function step(cmd, args) {
    log.push(`$ ${cmd} ${args.join(' ')}`);
    try {
      const { stdout, stderr } = await run(cmd, args, opts);
      if (stdout.trim()) log.push(stdout.trim());
      if (stderr.trim()) log.push(stderr.trim());
    } catch (err) {
      if (err.stderr?.trim()) log.push(err.stderr.trim());
      throw new DeployError(`${cmd} ${args.join(' ')} failed: ${err.message}`, log);
    }
  }

  await step('git', ['fetch', '--all']);

  try {
    await run('git', ['rev-parse', '--verify', '-q', `refs/remotes/${releaseRemote}/${branch}`], opts);
  } catch {
    throw new DeployError(`${releaseRemote}/${branch} not found on remote (after fetch)`, log);
  }

  const dirty = await run('git', ['status', '--porcelain'], opts);
  if (dirty.stdout.trim()) {
    throw new DeployError(`working tree is dirty, refusing to deploy:\n${dirty.stdout.trim()}`, log);
  }

  // Reset local phi-dev to match the remote exactly instead of merging into
  // whatever stale local phi-dev happens to be checked out — otherwise the
  // later push can be rejected as non-fast-forward, or worse, succeed against
  // an old base. Tries pushRemote first (the branch we're about to push back
  // to), falls back to releaseRemote for first-run bootstrap.
  let resetOk = false;
  for (const ref of [`${pushRemote}/phi-dev`, `${releaseRemote}/phi-dev`]) {
    try {
      await step('git', ['checkout', '-B', 'phi-dev', ref, '--']);
      resetOk = true;
      break;
    } catch {
      // try the next ref
    }
  }
  if (!resetOk) {
    throw new DeployError(`no phi-dev branch found on ${pushRemote} or ${releaseRemote}`, log);
  }

  try {
    await step('git', ['merge', '--no-edit', `${releaseRemote}/${branch}`]);
  } catch {
    const conflicts = await run('git', ['diff', '--name-only', '--diff-filter=U'], opts)
      .then((r) => r.stdout.trim())
      .catch(() => '(could not list conflicted files)');
    await run('git', ['merge', '--abort'], opts).catch(() => {});
    throw new DeployError(`merge conflict, aborted, nothing pushed:\n${conflicts}`, log);
  }

  await step('git', ['push', pushRemote, 'phi-dev']);
  await step('dotnet', ['ef', 'database', 'update', ...efArgs]);

  return log.join('\n');
}
