// Lock contention (#69): git fails at once when another process holds
// index.lock (or config.lock). gh-stack's git writes wait and retry instead,
// and report a lock that never frees as a GitLockError, never as a conflict.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { $ } from "bun";
import * as fs from "node:fs/promises";
import { closeSync, openSync } from "node:fs";
import * as git from "../git.ts";
import { getBranchMembership, setBranchMembership } from "../branch-config.ts";
import { cleanup, createTempRepo, makeCommit } from "../../__tests__/helpers.ts";
import { TEST_RETRY_DELAY_ENV } from "../retry-delay.ts";

let tmpDir: string;
let originalCwd: string;
let indexLock: string;

// These tests release locks after a real delay (250 ms, 1.5 s), so they need
// real waits: the preload's zero-wait override is lifted for this file (#108).
// FAST outlasts those holds: 50+100+200+400+800 ms ≈ 1.5 s in all.
const FAST = [50, 100, 200, 400, 800];
// For a lock that never frees, only the number of attempts matters.
const GIVE_UP = [10, 10, 10, 10, 10];
let savedRetryDelay: string | undefined;

beforeEach(async () => {
  tmpDir = await createTempRepo();
  indexLock = `${tmpDir}/.git/index.lock`;
  originalCwd = process.cwd();
  process.chdir(tmpDir);
  git.setLockRetryDelays(FAST);
  savedRetryDelay = process.env[TEST_RETRY_DELAY_ENV];
  delete process.env[TEST_RETRY_DELAY_ENV];
});

afterEach(async () => {
  git.setLockRetryDelays(null);
  if (savedRetryDelay !== undefined) process.env[TEST_RETRY_DELAY_ENV] = savedRetryDelay;
  process.chdir(originalCwd);
  await cleanup(tmpDir);
});

/** Hold a lock file now and let it go after `ms`, like a background `git status`. */
async function holdLock(file: string, ms: number): Promise<void> {
  await Bun.write(file, "");
  setTimeout(() => fs.rm(file, { force: true }), ms);
}

/** main gains a commit; `feature` has two of its own, based on the old main. */
async function divergedFeature(): Promise<void> {
  await $`git checkout -q -b feature`.quiet();
  await makeCommit(tmpDir, "f1.txt", "1\n", "f1");
  await makeCommit(tmpDir, "f2.txt", "2\n", "f2");
  await $`git checkout -q main`.quiet();
  await makeCommit(tmpDir, "m.txt", "m\n", "m");
}

async function onMain(ref: string): Promise<boolean> {
  return git.isAncestor("main", ref);
}

describe("heldLock", () => {
  test("finds the lock in checkout's and rebase's messages", () => {
    expect(
      git.heldLock("fatal: Unable to create '/r/.git/index.lock': File exists.\n\nAnother git"),
    ).toBe("/r/.git/index.lock");
    expect(git.heldLock("error: Unable to create '.git/HEAD.lock': File exists.")).toBe(
      ".git/HEAD.lock",
    );
  });

  test("finds the lock in git config's own wording", () => {
    expect(git.heldLock("error: could not lock config file .git/config: File exists")).toBe(
      ".git/config.lock",
    );
  });

  test("ignores other failures", () => {
    expect(git.heldLock("error: pathspec 'nope' did not match any file(s) known to git")).toBe(
      null,
    );
    expect(git.heldLock("CONFLICT (content): Merge conflict in a.txt")).toBe(null);
  });
});

describe("checkout", () => {
  test("waits out a briefly held index.lock", async () => {
    await $`git branch side`.quiet();
    await holdLock(indexLock, 250);
    await git.checkout("side");
    expect(await git.currentBranch()).toBe("side");
  });

  test("a lock that never frees is a GitLockError, and nothing moved", async () => {
    git.setLockRetryDelays(GIVE_UP);
    await $`git branch side`.quiet();
    await Bun.write(indexLock, "");
    const err = await git.checkout("side").catch((e) => e);
    expect(err).toBeInstanceOf(git.GitLockError);
    expect(err.lockPath).toEndWith("index.lock");
    expect(err.rebaseInProgress).toBe(false);
    expect(err.waitedMs).toBe(GIVE_UP.reduce((a, b) => a + b));
    expect(await git.currentBranch()).toBe("main");
  });

  test("other failures aren't retried", async () => {
    // Count the runs, not the time they took: one git spawn alone can take
    // longer than a retry delay on a loaded machine (#129).
    const result = await git.runGit(["checkout", "no-such-branch"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("no-such-branch");
    expect(result.attempts).toBe(1);
  });

  test("a held lock is retried, and the attempts are counted", async () => {
    await $`git branch side`.quiet();
    await holdLock(indexLock, 250);
    const result = await git.runGit(["checkout", "side"]);
    expect(result.exitCode).toBe(0);
    expect(result.attempts).toBeGreaterThan(1);
  });
});

describe("rebase", () => {
  test("a lock held when the rebase starts: runs it again", async () => {
    await divergedFeature();
    await $`git checkout -q feature`.quiet();
    await holdLock(indexLock, 250);
    expect((await git.rebaseBranch("feature", "main", "main~1")).ok).toBe(true);
    expect(await onMain("feature")).toBe(true);
    expect(await git.isRebaseInProgress()).toBe(false);
  });

  test("a lock that turns up midway: continues the paused rebase", async () => {
    await divergedFeature();
    await $`git checkout -q feature`.quiet();
    // After the first pick, take index.lock once (as a background reader
    // would) and let it go shortly after. git reschedules the next pick and
    // pauses; the retry continues the rebase.
    const marker = `${tmpDir}/.git/lock-taken`;
    const takeLockOnce = `test -e ${marker} || { touch ${marker} ${indexLock}; }`;
    const release = setInterval(async () => {
      if (await Bun.file(indexLock).exists()) {
        clearInterval(release);
        setTimeout(() => fs.rm(indexLock, { force: true }), 250);
      }
    }, 10);
    try {
      expect(await git.runRebase(["rebase", "-x", takeLockOnce, "main"])).toBe(true);
    } finally {
      clearInterval(release);
    }
    expect(await Bun.file(marker).exists()).toBe(true); // the lock really was taken midway
    expect(await git.isRebaseInProgress()).toBe(false);
    expect(await onMain("feature")).toBe(true);
    expect(await git.commitCount("main", "feature")).toBe(2);
  });

  test("a lock that never frees midway: paused, not reported as a conflict", async () => {
    git.setLockRetryDelays(GIVE_UP);
    await divergedFeature();
    await $`git checkout -q feature`.quiet();
    const err = await git.runRebase(["rebase", "-x", `touch ${indexLock}`, "main"]).catch((e) => e);
    expect(err).toBeInstanceOf(git.GitLockError);
    expect(err.rebaseInProgress).toBe(true);
    await fs.rm(indexLock, { force: true });
    await $`git rebase --abort`.quiet();
  });

  test("a real conflict still returns false", async () => {
    await $`git checkout -q -b feature`.quiet();
    await makeCommit(tmpDir, "README.md", "feature\n", "feature edit");
    await $`git checkout -q main`.quiet();
    await makeCommit(tmpDir, "README.md", "main\n", "main edit");
    await $`git checkout -q feature`.quiet();
    expect((await git.rebaseBranch("feature", "main", null)).ok).toBe(false);
    expect(await git.isRebaseInProgress()).toBe(true);
    await $`git rebase --abort`.quiet();
  });
});

describe("branch config", () => {
  test("a write waits out config.lock instead of being dropped", async () => {
    // git config waits about a second on its own; hold the lock past that.
    await holdLock(`${tmpDir}/.git/config.lock`, 1500);
    await setBranchMembership("main", { stack: "s1", parent: "trunk-ish" });
    expect(await getBranchMembership("main")).toMatchObject({ stack: "s1", parent: "trunk-ish" });
  });
});

describe("isCleanWorkingTree", () => {
  // The refresh only needs the lock when it has stale stat info to save, and
  // that's exactly when skipping it makes a clean tree look dirty. Touch the
  // file (same content, new mtime) so the stat info is stale.
  async function staleStat(): Promise<void> {
    const later = new Date(Date.now() + 5000);
    await fs.utimes(`${tmpDir}/README.md`, later, later);
  }

  test("a briefly held lock: waits, and a clean tree reads clean", async () => {
    await staleStat();
    await holdLock(indexLock, 250);
    expect(await git.isCleanWorkingTree()).toBe(true);
  });

  test("a lock that never frees surfaces instead of reading as dirty", async () => {
    git.setLockRetryDelays(GIVE_UP);
    await staleStat();
    await Bun.write(indexLock, "");
    await expect(git.isCleanWorkingTree()).rejects.toBeInstanceOf(git.GitLockError);
  });
});

// #71: who holds the lock. Every wait is logged with the holder lsof found.
describe("lock holder", () => {
  /**
   * A process that holds `file` open, as git holds a lock between taking and
   * committing it. `sleep` gets the file as its stdout, so it holds it from
   * the moment it starts: no shell that has yet to `exec` it (#129).
   */
  function holdOpen(file: string): Bun.Subprocess {
    const fd = openSync(file, "w");
    try {
      return Bun.spawn(["sleep", "30"], { stdout: fd });
    } finally {
      closeSync(fd);
    }
  }

  async function lockWaits(): Promise<Record<string, any>[]> {
    const text = await Bun.file(`${tmpDir}/.git/.gh-stack/lock-waits.log`).text();
    return text
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
  }

  test("lsof names the process holding the lock", async () => {
    const holder = holdOpen(indexLock);
    try {
      const found = await git.lockHolder(indexLock);
      expect("holders" in found && found.holders.join()).toContain(`pid ${holder.pid}: sleep 30`);
    } finally {
      holder.kill();
    }
  });

  test("nobody holding a leftover lock file", async () => {
    await Bun.write(indexLock, "");
    expect(await git.lockHolder(indexLock)).toEqual({ holders: [] });
  });

  test('lsof that times out is unknown, never "nobody has it open"', async () => {
    // A killed lsof prints nothing, which used to read as a stale lock and
    // told the user to rm a lock a live git still held (#129).
    const holder = holdOpen(indexLock);
    const saved = process.env[git.TEST_HELPER_TIMEOUT_ENV];
    try {
      process.env[git.TEST_HELPER_TIMEOUT_ENV] = "1";
      const found = await git.lockHolder(indexLock);
      expect(found).toEqual({ unknown: "lsof timed out" });
      expect(git.describeHolder(found)).toBe("unknown (lsof timed out)");
    } finally {
      process.env[git.TEST_HELPER_TIMEOUT_ENV] = saved;
      holder.kill();
    }
  });

  test("a wait that recovers is logged", async () => {
    await $`git branch side`.quiet();
    await holdLock(indexLock, 250);
    await git.checkout("side");
    const [entry, ...rest] = await lockWaits();
    expect(rest).toEqual([]);
    expect(entry).toMatchObject({
      lock: expect.stringContaining("index.lock"),
      worktree: tmpDir,
      command: "git checkout side",
      outcome: "recovered",
    });
    expect(entry!.attempts).toBeGreaterThan(1);
    expect(entry!.holder).toBeString();
  });

  test("giving up on a stale lock: logged, and the error says nobody holds it", async () => {
    git.setLockRetryDelays(GIVE_UP);
    await $`git branch side`.quiet();
    await Bun.write(indexLock, "");
    const err = await git.checkout("side").catch((e) => e);
    expect(err).toBeInstanceOf(git.GitLockError);
    expect(err.holder).toEqual({ holders: [] });
    const [entry] = await lockWaits();
    expect(entry).toMatchObject({ outcome: "gave-up", holderAtEnd: "nobody has it open" });
  });

  test("giving up on a held lock names the holder", async () => {
    git.setLockRetryDelays(GIVE_UP);
    await $`git branch side`.quiet();
    const holder = holdOpen(indexLock);
    try {
      const err = await git.checkout("side").catch((e) => e);
      expect(err).toBeInstanceOf(git.GitLockError);
      expect(err.holder.holders.join()).toContain(`pid ${holder.pid}`);
      const [entry] = await lockWaits();
      expect(entry!.holderAtEnd).toContain(`pid ${holder.pid}`);
    } finally {
      holder.kill();
    }
  });
});
