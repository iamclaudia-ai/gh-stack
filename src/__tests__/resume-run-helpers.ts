// Interrupted runs (#15, #29): every restack/sync keeps a saved state with an
// action log until its last push, `restack --resume` continues it (or reports
// that it finished), a bare `restack`/`sync` resumes a pending run instead of
// starting a different one, and a branch is never pushed onto a parent whose
// push didn't land.
//
// Shared by the resume-run-*.test.ts files: each calls useResumeRunRepos(), and reads the
// fixture dirs through the live bindings below.
import { afterEach, beforeEach, expect, setDefaultTimeout } from "bun:test";
import { $ } from "bun";
import * as fs from "node:fs/promises";
import {
  addConflictingMainCommit,
  checkout,
  cleanup,
  createGhStub,
  createLinearStack,
  createTempRepo,
  makeCommit,
  pushAllBranches,
  setupRemote,
} from "./helpers.ts";
import { RUN_STATE_VERSION, type RestackState } from "../types.ts";

export let tmpDir: string;
export let remoteDir: string;
export let stubDir: string;

/** A temp repo and a gh stub per test; a test that needs origin calls addRemote(). */
export function useResumeRunRepos(): void {
  // Each test builds repos and spawns the CLI several times; 5 s flakes under load.
  setDefaultTimeout(60_000);

  beforeEach(async () => {
    tmpDir = await createTempRepo();
    remoteDir = "";
    stubDir = await createGhStub();
  });

  afterEach(async () => {
    await cleanup(tmpDir, stubDir);
    if (remoteDir) await cleanup(remoteDir);
  });
}

/** Give the test repo a bare origin (removed after the test). */
export async function addRemote(): Promise<void> {
  remoteDir = await setupRemote(tmpDir);
}

const cliPath = new URL("../index.ts", import.meta.url).pathname;

export function cliEnv(env: Record<string, string>): Record<string, string> {
  const base = { ...process.env } as Record<string, string>;
  delete base.GH_STACK_YES;
  delete base.GH_STACK_NO_PUSH;
  return {
    ...base,
    PATH: `${stubDir}:${process.env.PATH}`,
    GH_LOG: `${stubDir}/calls.log`,
    NO_COLOR: "1",
    GH_STACK_NO_COLOR: "1",
    ...env,
  };
}

export function spawnCli(args: string[], env: Record<string, string>) {
  const proc = Bun.spawn(["bun", "run", cliPath, ...args], {
    cwd: tmpDir,
    env: cliEnv(env),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  proc.stdin.end();
  return proc;
}

export async function runCli(args: string[], env: Record<string, string> = { GH_STACK_YES: "1" }) {
  const proc = spawnCli(args, env);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, out: stdout + stderr };
}

export async function sha(ref: string): Promise<string> {
  return (await $`git -C ${tmpDir} rev-parse ${ref}`.text()).trim();
}

export async function remoteSha(branch: string): Promise<string> {
  const out = (await $`git -C ${tmpDir} ls-remote origin refs/heads/${branch}`.text()).trim();
  return out ? out.split(/\s+/)[0]! : "";
}

export async function isAncestor(a: string, b: string): Promise<boolean> {
  const { exitCode } = await $`git -C ${tmpDir} merge-base --is-ancestor ${a} ${b}`
    .nothrow()
    .quiet();
  return exitCode === 0;
}

export async function savedState(): Promise<RestackState | null> {
  const file = Bun.file(`${tmpDir}/.git/.gh-stack/restack-state.json`);
  return (await file.exists()) ? file.json() : null;
}

/** Install a pre-receive hook on the bare remote; `null` removes it. */
export async function setPreReceive(script: string | null): Promise<void> {
  const hook = `${remoteDir}/hooks/pre-receive`;
  if (script === null) {
    await fs.rm(hook, { force: true });
    return;
  }
  await Bun.write(hook, script);
  await fs.chmod(hook, 0o755);
}

export function rejectRef(branch: string): string {
  return `#!/bin/sh
while read old new ref; do
  if [ "$ref" = "refs/heads/${branch}" ]; then echo "rejected by test hook" >&2; exit 1; fi
done
exit 0
`;
}

/** main → pr1 → pr2 → pr3, all on origin, then a new commit on pr1. */
export async function stackNeedingRestack(): Promise<void> {
  await createLinearStack(tmpDir);
  await addRemote();
  await pushAllBranches(tmpDir);
  await checkout(tmpDir, "pr1");
  await makeCommit(tmpDir, "pr1-fix.txt", "fix\n", "fix on pr1");
}

/**
 * main → pr1 → pr2 → pr3 on origin, where main gains a commit that conflicts
 * with pr1. `sync` stops on pr1; the conflict is resolved and the rebase
 * continued, leaving the sync interrupted with pr2/pr3 still to restack.
 */
export async function syncStoppedOnConflictThenContinued(flags: string[] = []): Promise<void> {
  await createLinearStack(tmpDir, { conflicting: true });
  await addRemote();
  await pushAllBranches(tmpDir);
  await addConflictingMainCommit(tmpDir);
  await $`git -C ${tmpDir} push -q origin main`.quiet();
  await checkout(tmpDir, "pr1");

  const first = await runCli(["sync", ...flags]);
  expect(first.exitCode).toBe(2);
  expect(first.out).toContain("gh-stack restack --resume");

  await Bun.write(`${tmpDir}/shared.txt`, "resolved\n");
  await $`git -C ${tmpDir} add shared.txt`.quiet();
  await $`git -C ${tmpDir} rebase --continue`.env({ ...process.env, GIT_EDITOR: "true" }).quiet();
}

/** Write a saved run directly, for states that are hard to reach by interrupting a real run. */
export async function writeState(state: Partial<RestackState>): Promise<void> {
  const full: RestackState = {
    version: RUN_STATE_VERSION,
    command: "restack",
    stack_name: "test-stack",
    chain: ["pr1", "pr2", "pr3"],
    push_only: ["pr1"],
    current_index: 1,
    rebase: null,
    declined: [],
    push: true,
    started_at: new Date().toISOString(),
    finished_at: null,
    log: [],
    ...state,
  };
  await Bun.write(
    `${tmpDir}/.git/.gh-stack/restack-state.json`,
    JSON.stringify(full, null, 2) + "\n",
  );
}

/** A commit on main that touches nothing in the stack, pushed to origin. */
export async function advanceMain(file = "later.txt"): Promise<void> {
  const back = (await $`git -C ${tmpDir} branch --show-current`.text()).trim();
  await checkout(tmpDir, "main");
  await makeCommit(tmpDir, file, "later\n", `main: ${file}`);
  await $`git -C ${tmpDir} push -q origin main`.quiet();
  await checkout(tmpDir, back);
}

export async function currentBranch(): Promise<string> {
  return (await $`git -C ${tmpDir} branch --show-current`.text()).trim();
}
