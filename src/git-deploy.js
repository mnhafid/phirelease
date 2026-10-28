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

function gitOpts(repoDir) {
  return {
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
  const opts = gitOpts(repoDir);
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

/**
 * Fast-forward the checked-out branch to watchRef (e.g. "origin/phi-dev")
 * when it has moved, i.e. a PR was merged. Returns the new first-parent
 * commits (one line per merged PR), or null if already up to date.
 * Never merges or resets: refuses on wrong branch, dirty tree, or local
 * commits not on the remote.
 */
export async function pullIfBehind({ repoDir, watchRef }) {
  const [remote, branch] = splitRef(watchRef);
  const opts = gitOpts(repoDir);
  const git = async (...args) => (await run('git', args, opts)).stdout.trim();
  const isAncestor = (a, b) => run('git', ['merge-base', '--is-ancestor', a, b], opts).then(() => true, () => false);

  try {
    await git('fetch', remote, branch);
  } catch (err) {
    throw new DeployError(`git fetch ${remote} ${branch} failed: ${err.stderr?.trim() || err.message}`);
  }
  const remoteSha = await git('rev-parse', `refs/remotes/${watchRef}`);
  if (await isAncestor(remoteSha, 'HEAD')) return null; // up to date (or local is ahead, e.g. mid-deploy)

  const current = await git('rev-parse', '--abbrev-ref', 'HEAD');
  if (current !== branch) throw new DeployError(`${watchRef} has new commits but ${current} is checked out, not ${branch} — not pulling`);
  const dirty = await git('status', '--porcelain');
  if (dirty) throw new DeployError(`${watchRef} has new commits but working tree is dirty — not pulling:\n${dirty}`);
  if (!(await isAncestor('HEAD', remoteSha))) throw new DeployError(`local ${branch} has diverged from ${watchRef} — not pulling, fix by hand`);

  const commits = await git('log', '--oneline', '--first-parent', `HEAD..${remoteSha}`);
  await git('merge', '--ff-only', remoteSha);
  return commits;
}

function splitRef(ref) {
  const slash = ref.indexOf('/');
  return [ref.slice(0, slash), ref.slice(slash + 1)];
}

/**
 * Force-push the already-fetched watchRef commit to target ("ups/ict-dev").
 * Pushes the remote-tracking ref, not HEAD, so stray local commits can never
 * leak into the target. Compares first, so it's a cheap no-op when in sync —
 * and a failed push is retried on the next trigger instead of being forgotten.
 * Returns true if it pushed.
 */
export async function forcePushTo({ repoDir, watchRef, target }) {
  const [remote, branch] = splitRef(target);
  const opts = gitOpts(repoDir);
  const git = async (...args) => (await run('git', args, opts)).stdout.trim();
  try {
    const sha = await git('rev-parse', `refs/remotes/${watchRef}`);
    const current = (await git('ls-remote', remote, `refs/heads/${branch}`)).split(/\s/)[0];
    if (current === sha) return false;
    await git('push', '--force', remote, `${sha}:refs/heads/${branch}`);
    return true;
  } catch (err) {
    throw new DeployError(`force-push to ${target} failed: ${err.stderr?.trim() || err.message}`);
  }
}
