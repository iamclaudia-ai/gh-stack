// #28: a collapsed stack must not silently lose its children's content.
//
// Secondary guard: restack/sync stop before rewriting a branch whose origin
// copy has commits the local branch never had (a collapse's squash commit),
// but not for the pre-rewrite versions a --no-push run leaves on origin.
//
// Primary guard: before the base PR is handed to main, `merge` checks each
// collapsed child's squash commit is still in what it was squashed into.
//
// A second clone stands in for GitHub: it makes the squash commits and pushes
// them, the way `gh pr merge --squash` would on the server.
//
// Shared by the collapse-guard-*.test.ts files: each calls useCollapseGuardRepos() for the
// repos, and reads them through the live bindings below.
import { afterEach, beforeEach, setDefaultTimeout } from "bun:test";
import { $ } from "bun";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  cleanup,
  createLinearStack,
  createTempRepo,
  pushAllBranches,
  setupRemote,
} from "./helpers.ts";
import type { CommitFile } from "../lib/collapse-guard.ts";
import type { PrMergeResult } from "../lib/github.ts";

export type MergeFacts = Pick<
  PrMergeResult,
  "state" | "baseRefName" | "headRefOid" | "mergeCommit"
>;

export let tmpDir: string;
export let remoteDir: string;
export let otherDir: string;
export let binDir: string;
export let originalCwd: string;

/** main → pr1 → pr2 → pr3 (PRs #1-#3) on a bare remote, a "GitHub" clone, and a dir for the fake gh. */
export function useCollapseGuardRepos(): void {
  setDefaultTimeout(60_000);

  beforeEach(async () => {
    tmpDir = await createTempRepo();
    await createLinearStack(tmpDir); // main → pr1 → pr2 → pr3, PRs #1-#3
    remoteDir = await setupRemote(tmpDir);
    await pushAllBranches(tmpDir);
    // GitHub serves reachable commits by sha (e.g. a merged PR's head); an
    // orphaned squash commit isn't fetchable.
    await $`git -C ${remoteDir} config uploadpack.allowReachableSHA1InWant true`.quiet();
    otherDir = await fs.mkdtemp(path.join(await fs.realpath("/tmp"), "gh-stack-github-"));
    await $`git clone -q ${remoteDir} ${otherDir}`.quiet();
    await $`git -C ${otherDir} config user.email gh@test`.quiet();
    await $`git -C ${otherDir} config user.name GitHub`.quiet();
    binDir = await fs.mkdtemp(path.join(await fs.realpath("/tmp"), "gh-stack-fakegh-"));
    originalCwd = process.cwd();
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await cleanup(tmpDir, remoteDir, otherDir, binDir);
  });
}

const cliPath = new URL("../index.ts", import.meta.url).pathname;

export async function runCli(args: string[], env: Record<string, string> = { GH_STACK_YES: "1" }) {
  const base = { ...process.env } as Record<string, string>;
  delete base.GH_STACK_YES;
  delete base.GH_STACK_NO_PUSH;
  const proc = Bun.spawn(["bun", "run", cliPath, ...args], {
    cwd: tmpDir,
    env: {
      ...base,
      PATH: `${binDir}:${process.env.PATH}`,
      GH_LOG: `${binDir}/gh.log`,
      GH_PR_DIR: binDir,
      NO_COLOR: "1",
      GH_STACK_NO_COLOR: "1",
      ...env,
    },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  proc.stdin.end();
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, out: stdout + stderr };
}

/** A fake `gh`: `pr view N --json …` prints $GH_PR_DIR/N.json; everything else succeeds silently. */
export async function installGhStub(): Promise<void> {
  await Bun.write(
    `${binDir}/gh`,
    `#!/bin/sh
echo "$*" >> "$GH_LOG"
if [ "$1 $2" = "pr view" ]; then
  n=$(cat "$GH_PR_DIR/count-$3" 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" > "$GH_PR_DIR/count-$3"
  for spec in $(echo "$GH_FAIL_VIEW" | tr ',' ' '); do
    if [ "\${spec%%:*}" = "$3" ] && [ "$n" -ge "\${spec#*:}" ]; then echo "HTTP 502: Bad Gateway" >&2; exit 1; fi
  done
  if [ -f "$GH_PR_DIR/$3.json" ]; then cat "$GH_PR_DIR/$3.json"; fi
fi
if [ "$1 $2" = "repo view" ]; then echo acme/widgets; fi
if [ "$1" = "api" ]; then
  if [ "$2" = "-H" ]; then kind=patch; path="$4"; else kind=files; path="$2"; fi
  f="$GH_PR_DIR/$kind-\${path##*/}"
  if [ -f "$f" ]; then cat "$f"; exit 0; fi
  exit 1
fi
exit 0
`,
  );
  await fs.chmod(`${binDir}/gh`, 0o755);
}

export async function writePr(n: number, data: Record<string, unknown>): Promise<void> {
  await Bun.write(`${binDir}/${n}.json`, JSON.stringify(data));
}

export async function git(dir: string, ...args: string[]): Promise<string> {
  return (await $`git -C ${dir} ${args}`.text()).trim();
}

export async function remoteSha(branch: string): Promise<string> {
  return (await git(remoteDir, "rev-parse", `refs/heads/${branch}`)).trim();
}

/** On "GitHub": squash `child` into `parent` and push. Returns the squash commit. */
export async function squashOnGithub(
  child: string,
  parent: string,
  title: string,
): Promise<string> {
  await git(otherDir, "checkout", "-q", parent);
  await git(otherDir, "pull", "-q", "--ff-only", "origin", parent);
  await git(otherDir, "fetch", "-q", "origin", child);
  await git(otherDir, "merge", "--squash", `origin/${child}`);
  await git(otherDir, "commit", "-q", "-m", title);
  await git(otherDir, "push", "-q", "origin", parent);
  return git(otherDir, "rev-parse", "HEAD");
}

/**
 * Force-push `branch` from "GitHub" and drop the commits that orphans from the
 * remote. A local bare remote would otherwise still serve them by sha (protocol
 * v2 doesn't enforce reachability), unlike GitHub for an orphaned squash commit.
 */
export async function forcePushOrphaning(branch: string): Promise<void> {
  await git(otherDir, "push", "-q", "-f", "origin", branch);
  await git(remoteDir, "reflog", "expire", "--expire=now", "--all");
  await git(remoteDir, "gc", "-q", "--prune=now");
}

/** The files a commit wrote, shaped like GitHub's commits API (path, status, blob). */
export async function filesOf(dir: string, sha: string): Promise<CommitFile[]> {
  const out = (await $`git -C ${dir} diff-tree -r -z --no-commit-id --root ${sha}`.text()).split(
    "\0",
  );
  const files: CommitFile[] = [];
  for (let i = 0; i + 1 < out.length; i += 2) {
    const [, , , blob, status] = out[i]!.replace(/^:/, "").split(" ");
    const filename = out[i + 1]!;
    if (status === "D") files.push({ filename, status: "removed", sha: null });
    else if (status === "A") files.push({ filename, status: "added", sha: blob!, before: null });
    else files.push({ filename, status: "modified", sha: blob! });
  }
  return files;
}

/** main moves on origin, so sync has something to rebase onto. */
export async function moveMainOnOrigin(): Promise<void> {
  await git(otherDir, "checkout", "-q", "main");
  await Bun.write(`${otherDir}/main-new.txt`, "new\n");
  await git(otherDir, "add", "main-new.txt");
  await git(otherDir, "commit", "-q", "-m", "main moves");
  await git(otherDir, "push", "-q", "origin", "main");
}
