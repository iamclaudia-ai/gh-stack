// #51: `merge --base` must re-root the next branch onto the trunk as it is
// AFTER the bottom PR's squash lands, not the trunk it fetched before merging.
// Also: GH_STACK_NO_PUSH keeps the re-root local, and a re-root that stopped
// (on a conflict, or a trunk that doesn't show the merge yet) is finished by
// re-running `merge --base`.
//
// A second clone stands in for GitHub: the fake `gh pr merge 1` squashes PR #1
// into main there and pushes it, then reports the PR as MERGED.
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { $ } from "bun";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  checkout,
  cleanup,
  createLinearStack,
  createTempRepo,
  PR_BASE_STUB,
  pushAllBranches,
  readMetadata,
  setupRemote,
} from "./helpers.ts";

setDefaultTimeout(60_000);

let tmpDir: string;
let remoteDir: string;
let otherDir: string;
let binDir: string;
let shas: Record<string, string>;

beforeEach(async () => {
  tmpDir = await createTempRepo();
  ({ shas } = await createLinearStack(tmpDir)); // main → pr1 → pr2 → pr3, PRs #1-#3
  remoteDir = await setupRemote(tmpDir);
  await pushAllBranches(tmpDir);
  otherDir = await fs.mkdtemp(path.join(await fs.realpath("/tmp"), "gh-stack-github-"));
  await $`git clone -q ${remoteDir} ${otherDir}`.quiet();
  await $`git -C ${otherDir} config user.email gh@test`.quiet();
  await $`git -C ${otherDir} config user.name GitHub`.quiet();
  binDir = await fs.mkdtemp(path.join(await fs.realpath("/tmp"), "gh-stack-fakegh-"));
  await installGhStub();
  await writePr(1, openPr("pr1", "main", shas.pr1!));
  await writePr(2, openPr("pr2", "pr1", shas.pr2!));
  await writePr(3, openPr("pr3", "pr2", shas.pr3!));
});

afterEach(async () => {
  await cleanup(tmpDir, remoteDir, otherDir, binDir);
});

const cliPath = new URL("../index.ts", import.meta.url).pathname;

async function runCli(args: string[], env: Record<string, string> = {}) {
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
      GH_STACK_YES: "1",
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

/**
 * A fake `gh`: `pr view N` prints $GH_PR_DIR/N.json, `pr merge N` runs
 * $GH_PR_DIR/merge-N.sh, `repo view` names a repo, and `api` fails (no live
 * branch refs, so merge never tries to heal a stale PR head).
 */
async function installGhStub(): Promise<void> {
  await Bun.write(
    `${binDir}/gh`,
    `#!/bin/sh
echo "$*" >> "$GH_LOG"
if [ "$1 $2" = "pr view" ]; then cat "$GH_PR_DIR/$3.json"; exit 0; fi
if [ "$1 $2" = "pr merge" ]; then
  sh "$GH_PR_DIR/merge-$3.sh" || exit 1
  # Like gh: --delete-branch removes the head branch on origin and locally.
  case "$*" in *--delete-branch*)
    head=$(sed 's/.*"headRefName":"\\([^"]*\\)".*/\\1/' "$GH_PR_DIR/$3.json")
    git push -q origin --delete "$head"
    git branch -q -D "$head"
  esac
  exit 0
fi
if [ "$1 $2" = "repo view" ]; then echo acme/widgets; exit 0; fi
${PR_BASE_STUB}
if [ "$1" = "api" ]; then exit 1; fi
exit 0
`,
  );
  await fs.chmod(`${binDir}/gh`, 0o755);
}

function openPr(head: string, base: string, headSha: string): Record<string, unknown> {
  return {
    state: "OPEN",
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    headRefName: head,
    headRefOid: headSha,
    baseRefName: base,
    mergeCommit: null,
  };
}

async function writePr(n: number, data: Record<string, unknown>): Promise<void> {
  await Bun.write(`${binDir}/${n}.json`, JSON.stringify(data));
}

/**
 * `gh pr merge 1` squashes pr1 into main on "GitHub" and pushes it, then
 * reports PR #1 as MERGED with that commit. With `landOnMain: false`, GitHub
 * reports the merge but origin's main never shows it.
 */
async function githubSquashesPr1(opts: { landOnMain: boolean } = { landOnMain: true }) {
  const g = `git -C '${otherDir}'`;
  await Bun.write(
    `${binDir}/merge-1.sh`,
    `set -e
${g} checkout -q main
${g} pull -q --ff-only origin main
${g} fetch -q origin pr1
${g} merge -q --squash origin/pr1 >/dev/null
${g} commit -q -m 'PR 1 (#1)'
${opts.landOnMain ? `${g} push -q origin main` : ""}
sha=$(${g} rev-parse HEAD)
printf '{"state":"MERGED","mergeable":"UNKNOWN","mergeStateStatus":"UNKNOWN","headRefName":"pr1","headRefOid":"${shas.pr1}","baseRefName":"main","mergeCommit":{"oid":"%s"}}' "$sha" > '${binDir}/1.json'
`,
  );
}

async function git(dir: string, ...args: string[]): Promise<string> {
  return (await $`git -C ${dir} ${args}`.text()).trim();
}

async function contains(dir: string, ancestor: string, ref: string): Promise<boolean> {
  return (
    (await $`git -C ${dir} merge-base --is-ancestor ${ancestor} ${ref}`.nothrow().quiet())
      .exitCode === 0
  );
}

async function remoteSha(branch: string): Promise<string> {
  return git(remoteDir, "rev-parse", `refs/heads/${branch}`);
}

async function remoteHas(branch: string): Promise<boolean> {
  return (
    (await $`git -C ${remoteDir} rev-parse --verify -q refs/heads/${branch}`.nothrow().quiet())
      .exitCode === 0
  );
}

/** The fake gh's calls, in order. */
async function ghCalls(): Promise<string[]> {
  return (await Bun.file(`${binDir}/gh.log`).text()).trim().split("\n");
}

/** main moves on "GitHub" with a pr2.txt of its own, so re-rooting pr2 conflicts. */
async function mainAddsConflictingPr2File(): Promise<void> {
  await git(otherDir, "checkout", "-q", "main");
  await Bun.write(`${otherDir}/pr2.txt`, "main's version\n");
  await git(otherDir, "add", "pr2.txt");
  await git(otherDir, "commit", "-q", "-m", "main: its own pr2.txt");
  await git(otherDir, "push", "-q", "origin", "main");
}

/** Someone else's PR lands on "GitHub"'s main: it moves on, touching nothing of ours. */
async function mainMovesOn(): Promise<void> {
  await git(otherDir, "checkout", "-q", "main");
  await git(otherDir, "pull", "-q", "--ff-only", "origin", "main");
  await Bun.write(`${otherDir}/elsewhere.txt`, "someone else's change\n");
  await git(otherDir, "add", "elsewhere.txt");
  await git(otherDir, "commit", "-q", "-m", "main: someone else's PR");
  await git(otherDir, "push", "-q", "origin", "main");
}

describe("merge --base re-roots onto the trunk after the squash (#51)", () => {
  test("the next branch lands on main with the merged PR's squash, and the tail follows", async () => {
    await githubSquashesPr1();
    await checkout(tmpDir, "pr1");

    const res = await runCli(["merge", "--base"]);

    expect(res.exitCode).toBe(0);
    const squash = await remoteSha("main");
    expect(squash).not.toBe(shas.main);
    // On origin and locally, pr2 sits on the squash, and pr3 on pr2.
    expect(await contains(remoteDir, squash, "refs/heads/pr2")).toBe(true);
    expect(await contains(remoteDir, "refs/heads/pr2", "refs/heads/pr3")).toBe(true);
    expect(await contains(tmpDir, squash, "pr2")).toBe(true);
    // pr2's PR diff is just pr2.txt: nothing of pr1's shows as deleted.
    expect(await git(tmpDir, "diff", "--name-status", `${squash}...pr2`)).toBe("A\tpr2.txt");
    expect(await git(tmpDir, "rev-list", "--count", `${squash}..pr2`)).toBe("1");
    const calls = await Bun.file(`${binDir}/gh.log`).text();
    expect(calls).toContain("pr edit 2 --base main");
    const meta = await readMetadata(tmpDir);
    expect(meta.stacks["test-stack"]!.branches["pr1"]).toBeUndefined();
    expect(meta.stacks["test-stack"]!.branches["pr2"]!.parent).toBe("main");
  });

  test("with --delete-branch, which deletes the merged branch locally too", async () => {
    await githubSquashesPr1();
    await checkout(tmpDir, "pr1");

    const res = await runCli(["merge", "--base", "--delete-branch"]);

    expect(res.exitCode).toBe(0);
    expect(res.out).toContain("Deleted pr1 on GitHub and locally");
    expect(await git(tmpDir, "branch", "--list", "pr1")).toBe("");
    expect(await remoteHas("pr1")).toBe(false);
    const squash = await remoteSha("main");
    expect(await contains(remoteDir, squash, "refs/heads/pr2")).toBe(true);
    expect(await git(tmpDir, "rev-list", "--count", `${squash}..pr2`)).toBe("1");
    expect(await contains(remoteDir, "refs/heads/pr2", "refs/heads/pr3")).toBe(true);
  });

  test("stops before re-rooting when origin's main doesn't show the merge", async () => {
    await githubSquashesPr1({ landOnMain: false });
    await checkout(tmpDir, "pr1");
    const pr2 = await git(tmpDir, "rev-parse", "pr2");

    const res = await runCli(["merge", "--base"]);

    expect(res.exitCode).toBe(2);
    expect(res.out).toContain("PR #1 is merged, but origin/main doesn't show its merge commit");
    expect(res.out).toContain("gh-stack merge --base");
    // Nothing was re-rooted or pushed, and the stack still has pr1.
    expect(await git(tmpDir, "rev-parse", "pr2")).toBe(pr2);
    expect(await remoteSha("pr2")).toBe(pr2);
    const meta = await readMetadata(tmpDir);
    expect(meta.stacks["test-stack"]!.branches["pr2"]!.parent).toBe("pr1");
  });
});

// #100: -d handed gh --delete-branch, so GitHub deleted pr1 the moment PR #1
// merged, while PR #2 still targeted it. GitHub closes a PR whose base branch
// is deleted, and won't reopen it once its head has been pushed again.
describe("merge --base -d deletes the merged branch only once no PR targets it (#100)", () => {
  test("deletes pr1 after PR #2 is retargeted, not with the merge", async () => {
    await githubSquashesPr1();
    await checkout(tmpDir, "pr1");

    const res = await runCli(["merge", "--base", "-d"]);

    expect(res.exitCode).toBe(0);
    const calls = await ghCalls();
    expect(calls.filter((c) => c.startsWith("pr merge")).join("\n")).not.toContain(
      "--delete-branch",
    );
    const retarget = calls.indexOf("pr edit 2 --base main");
    const deletion = calls.findIndex((c) => c.startsWith("api --method DELETE"));
    expect(retarget).toBeGreaterThan(-1);
    expect(deletion).toBeGreaterThan(retarget);
    expect(calls[deletion]).toEndWith("/git/refs/heads/pr1");
    expect(await remoteHas("pr1")).toBe(false);
    // The API leaves the remote-tracking ref behind; merge -d drops it.
    const tracking = $`git -C ${tmpDir} rev-parse --verify -q refs/remotes/origin/pr1`;
    expect((await tracking.nothrow().quiet()).exitCode).not.toBe(0);
  });

  test("a retarget that keeps failing keeps pr1, on GitHub and locally, and says why", async () => {
    await githubSquashesPr1();
    await Bun.write(`${binDir}/edit-2.fails`, "99");
    await checkout(tmpDir, "pr1");

    const res = await runCli(["merge", "--base", "-d"]);

    expect(res.exitCode).toBe(0);
    expect(res.out).toContain(
      "Could not retarget PR #2 (GraphQL: Something went wrong (updatePullRequest))",
    );
    expect(res.out).toContain("Kept pr1: PR #2 still targets it.");
    expect(res.out).toContain("delete it with git push --no-verify origin --delete pr1");
    const calls = await ghCalls();
    // Three tries before giving up.
    expect(calls.filter((c) => c === "pr edit 2 --base main").length).toBeGreaterThanOrEqual(3);
    expect(calls.some((c) => c.startsWith("api --method DELETE"))).toBe(false);
    expect(await remoteHas("pr1")).toBe(true);
    expect(await git(tmpDir, "branch", "--list", "pr1")).not.toBe("");
  });

  test("a retarget that fails once is retried, and pr1 is then deleted", async () => {
    await githubSquashesPr1();
    await Bun.write(`${binDir}/edit-2.fails`, "1");
    await checkout(tmpDir, "pr1");

    const res = await runCli(["merge", "--base", "-d"]);

    expect(res.exitCode).toBe(0);
    expect(res.out).toContain("PR #2 base → main");
    expect(res.out).not.toContain("Could not retarget");
    expect((await ghCalls()).filter((c) => c === "pr edit 2 --base main").length).toBe(2);
    expect(await remoteHas("pr1")).toBe(false);
  });

  test("--no-push leaves PR #2 on pr1, so pr1 is kept", async () => {
    await githubSquashesPr1();
    await checkout(tmpDir, "pr1");

    const res = await runCli(["merge", "--base", "-d", "--no-push"]);

    expect(res.exitCode).toBe(0);
    expect(res.out).toContain("Kept pr1: PR #2 still targets it.");
    expect(await remoteHas("pr1")).toBe(true);
  });
});

describe("merge --base --no-push (#51)", () => {
  test("GH_STACK_NO_PUSH merges on GitHub but keeps the re-root and tail local", async () => {
    await githubSquashesPr1();
    await checkout(tmpDir, "pr1");

    const res = await runCli(["merge", "--base"], { GH_STACK_NO_PUSH: "1" });

    expect(res.exitCode).toBe(0);
    const squash = await remoteSha("main");
    expect(squash).not.toBe(shas.main);
    expect(await contains(tmpDir, squash, "pr2")).toBe(true);
    expect(await contains(tmpDir, "pr2", "pr3")).toBe(true);
    // Origin and the PR base are untouched.
    expect(await remoteSha("pr2")).toBe(shas.pr2!);
    expect(await remoteSha("pr3")).toBe(shas.pr3!);
    const calls = await Bun.file(`${binDir}/gh.log`).text();
    expect(calls).toContain("pr merge 1 --squash");
    expect(calls).not.toContain("pr edit");
  });

  test("--push wins over GH_STACK_NO_PUSH", async () => {
    await githubSquashesPr1();
    await checkout(tmpDir, "pr1");

    const res = await runCli(["merge", "--base", "--push"], { GH_STACK_NO_PUSH: "1" });

    expect(res.exitCode).toBe(0);
    expect(await contains(remoteDir, await remoteSha("main"), "refs/heads/pr2")).toBe(true);
  });
});

describe("a re-root stopped on a conflict is finished by re-running (#51)", () => {
  test("resolve, continue, re-run merge --base -d: pr2 is pushed and retargeted, pr3 follows", async () => {
    await mainAddsConflictingPr2File();
    await githubSquashesPr1();
    await checkout(tmpDir, "pr1");

    const first = await runCli(["merge", "--base", "-d"]);
    expect(first.exitCode).toBe(2);
    expect(first.out).toContain("Rebase conflict re-rooting pr2 onto main");
    expect(first.out).toContain("gh-stack merge --base");

    await Bun.write(`${tmpDir}/pr2.txt`, "resolved\n");
    await git(tmpDir, "add", "pr2.txt");
    await $`git -C ${tmpDir} -c core.editor=true rebase --continue`.quiet();

    const second = await runCli(["merge", "--base", "-d"]);

    expect(second.exitCode).toBe(0);
    expect(second.out).toContain("pr2 is already on main");
    const squash = await remoteSha("main");
    expect(await remoteSha("pr2")).toBe(await git(tmpDir, "rev-parse", "pr2"));
    expect(await contains(remoteDir, squash, "refs/heads/pr2")).toBe(true);
    expect(await contains(remoteDir, "refs/heads/pr2", "refs/heads/pr3")).toBe(true);
    // pr3 carries only its own commit on top of the re-rooted pr2.
    expect(await git(tmpDir, "rev-list", "--count", "pr2..pr3")).toBe("1");
    const calls = await Bun.file(`${binDir}/gh.log`).text();
    expect(calls).toContain("pr edit 2 --base main");
    const meta = await readMetadata(tmpDir);
    expect(meta.stacks["test-stack"]!.branches["pr1"]).toBeUndefined();
    expect(meta.stacks["test-stack"]!.branches["pr2"]!.parent).toBe("main");
  });
});

describe("sync's re-root stopped on a conflict is finished by re-running sync (#51)", () => {
  test("resolve, continue, re-run sync: pr2 is pushed and retargeted, pr3 follows", async () => {
    await mainAddsConflictingPr2File();
    // PR #1 merges on GitHub outside gh-stack.
    await githubSquashesPr1();
    await $`sh ${binDir}/merge-1.sh`.quiet();
    await checkout(tmpDir, "pr2");

    const first = await runCli(["sync"]);
    expect(first.exitCode).toBe(2);
    expect(first.out).toContain("Rebase conflict re-rooting pr2 onto main");
    expect(first.out).toContain("gh-stack sync");

    await Bun.write(`${tmpDir}/pr2.txt`, "resolved\n");
    await git(tmpDir, "add", "pr2.txt");
    await $`git -C ${tmpDir} -c core.editor=true rebase --continue`.quiet();

    const second = await runCli(["sync"]);

    expect(second.exitCode).toBe(0);
    expect(second.out).toContain("pr2 is already on main");
    const squash = await remoteSha("main");
    expect(await remoteSha("pr2")).toBe(await git(tmpDir, "rev-parse", "pr2"));
    expect(await contains(remoteDir, squash, "refs/heads/pr2")).toBe(true);
    expect(await contains(remoteDir, "refs/heads/pr2", "refs/heads/pr3")).toBe(true);
    expect(await git(tmpDir, "rev-list", "--count", "pr2..pr3")).toBe("1");
    const calls = await Bun.file(`${binDir}/gh.log`).text();
    expect(calls).toContain("pr edit 2 --base main");
    const meta = await readMetadata(tmpDir);
    expect(meta.stacks["test-stack"]!.branches["pr1"]).toBeUndefined();
    expect(meta.stacks["test-stack"]!.branches["pr2"]!.parent).toBe("main");
  });
});

// #132: on a busy repo, main moves on between the run that stopped and the
// re-run. The re-run fetches it again, so the re-rooted branch no longer
// contains origin/main, and it used to be re-rooted a second time from the
// merge-base with the merged branch: the old fork point on main, replaying
// every main commit since. Holding the merged PR's squash commit is the proof.
describe("a re-run after main moved on finishes the re-root without redoing it (#132)", () => {
  async function stopOnConflictThenResolve(command: string[]): Promise<void> {
    const first = await runCli(command);
    expect(first.exitCode).toBe(2);
    expect(first.out).toContain("Rebase conflict re-rooting pr2 onto main");
    await Bun.write(`${tmpDir}/pr2.txt`, "resolved\n");
    await git(tmpDir, "add", "pr2.txt");
    await $`git -C ${tmpDir} -c core.editor=true rebase --continue`.quiet();
  }

  test("merge --base: pr2 is pushed as resolved, not re-rooted again", async () => {
    await mainAddsConflictingPr2File();
    await githubSquashesPr1();
    await checkout(tmpDir, "pr1");
    await stopOnConflictThenResolve(["merge", "--base"]);
    const resolved = await git(tmpDir, "rev-parse", "pr2");
    await mainMovesOn();

    const second = await runCli(["merge", "--base"]);

    expect(second.exitCode).toBe(0);
    expect(second.out).toContain("pr2 is already on main");
    expect(second.out).not.toContain("Re-rooting pr2");
    expect(await git(tmpDir, "rev-parse", "pr2")).toBe(resolved);
    expect(await remoteSha("pr2")).toBe(resolved);
    expect(await git(tmpDir, "rev-list", "--count", "pr2..pr3")).toBe("1");
    expect(await ghCalls()).toContain("pr edit 2 --base main");
    const meta = await readMetadata(tmpDir);
    expect(meta.stacks["test-stack"]!.branches["pr1"]).toBeUndefined();
    expect(meta.stacks["test-stack"]!.branches["pr2"]!.parent).toBe("main");
  });

  test("sync: pr2 is not re-rooted again, and the usual sync rebases it onto the new main", async () => {
    await mainAddsConflictingPr2File();
    await githubSquashesPr1();
    await $`sh ${binDir}/merge-1.sh`.quiet();
    await checkout(tmpDir, "pr2");
    await stopOnConflictThenResolve(["sync"]);
    await mainMovesOn();

    const second = await runCli(["sync"]);

    expect(second.exitCode).toBe(0);
    expect(second.out).toContain("pr2 is already on main");
    expect(second.out).not.toContain("Re-rooting pr2");
    // Then sync's own rebase moves it onto the new main: one commit of its own.
    const main = await remoteSha("main");
    expect(await contains(remoteDir, main, "refs/heads/pr2")).toBe(true);
    expect(await git(tmpDir, "rev-list", "--count", `${main}..pr2`)).toBe("1");
    expect(await git(tmpDir, "rev-list", "--count", "pr2..pr3")).toBe("1");
    expect(await ghCalls()).toContain("pr edit 2 --base main");
  });
});

/**
 * Log every push origin receives into the fake gh's log, so a test sees pushes
 * and PR edits in one order; a `reject-<branch>` file in binDir refuses that
 * branch's push.
 */
async function logPushes(): Promise<void> {
  const hook = `${remoteDir}/hooks/pre-receive`;
  await Bun.write(
    hook,
    `#!/bin/sh
status=0
while read old new ref; do
  b=\${ref#refs/heads/}
  if [ -f '${binDir}'/reject-"$b" ]; then echo "rejected $b" >&2; status=1; continue; fi
  echo "push $b" >> '${binDir}/gh.log'
done
exit $status
`,
  );
  await fs.chmod(hook, 0o755);
}

// #133: a push made while the PR still targets the merged branch fires CI with
// that base, and a trunk's required check never counts for the retargeted PR.
// So the PR moves to the trunk first, and back again if the push fails.
describe("the re-rooted branch's PR is retargeted before its push (#133)", () => {
  test("merge --base: PR #2 → main, then pr2 is pushed", async () => {
    await githubSquashesPr1();
    await logPushes();
    await checkout(tmpDir, "pr1");

    const res = await runCli(["merge", "--base"]);

    expect(res.exitCode).toBe(0);
    const calls = await ghCalls();
    const retarget = calls.indexOf("pr edit 2 --base main");
    expect(retarget).toBeGreaterThan(-1);
    expect(calls.indexOf("push pr2")).toBeGreaterThan(retarget);
  });

  test("merge --base: a failed push puts PR #2 back on pr1; restack --resume moves it before pushing", async () => {
    await githubSquashesPr1();
    await logPushes();
    await Bun.write(`${binDir}/reject-pr2`, "");
    await checkout(tmpDir, "pr1");

    const res = await runCli(["merge", "--base"]);

    expect(res.out).toContain("Push of pr2 failed");
    let calls = await ghCalls();
    expect(calls).not.toContain("push pr2");
    const forth = calls.indexOf("pr edit 2 --base main");
    expect(forth).toBeGreaterThan(-1);
    expect(calls.indexOf("pr edit 2 --base pr1")).toBeGreaterThan(forth);
    expect(JSON.parse(await Bun.file(`${binDir}/2.json`).text()).baseRefName).toBe("pr1");
    expect((await readMetadata(tmpDir)).stacks["test-stack"]!.branches["pr2"]!.prBase).toBe("pr1");

    // The push goes through now: the PR moves first, then pr2 is pushed.
    await fs.rm(`${binDir}/reject-pr2`);
    await fs.rm(`${binDir}/gh.log`);
    await checkout(tmpDir, "pr2");
    const resumed = await runCli(["restack", "--resume"]);

    expect(resumed.exitCode).toBe(0);
    calls = await ghCalls();
    const retarget = calls.indexOf("pr edit 2 --base main");
    expect(retarget).toBeGreaterThan(-1);
    expect(calls.indexOf("push pr2")).toBeGreaterThan(retarget);
    expect(JSON.parse(await Bun.file(`${binDir}/2.json`).text()).baseRefName).toBe("main");
    expect((await readMetadata(tmpDir)).stacks["test-stack"]!.branches["pr2"]!.prBase).toBe("main");
  });

  test("submit after merge --base --no-push: PR #2 → main, then pr2 is pushed", async () => {
    await githubSquashesPr1();
    await checkout(tmpDir, "pr1");
    const merged = await runCli(["merge", "--base", "--no-push"]);
    expect(merged.exitCode).toBe(0);
    await logPushes();
    await fs.rm(`${binDir}/gh.log`);
    await checkout(tmpDir, "pr2");

    const res = await runCli(["submit", "--no-edit"]);

    expect(res.exitCode).toBe(0);
    const calls = await ghCalls();
    const retarget = calls.indexOf("pr edit 2 --base main");
    expect(retarget).toBeGreaterThan(-1);
    expect(calls.indexOf("push pr2")).toBeGreaterThan(retarget);
    expect(calls.filter((c) => c.startsWith("pr edit 2 --base"))).toEqual([
      "pr edit 2 --base main",
    ]);
  });

  test("submit: a failed push puts PR #2 back on pr1", async () => {
    await githubSquashesPr1();
    await checkout(tmpDir, "pr1");
    expect((await runCli(["merge", "--base", "--no-push"])).exitCode).toBe(0);
    await logPushes();
    await Bun.write(`${binDir}/reject-pr2`, "");
    await fs.rm(`${binDir}/gh.log`);
    await checkout(tmpDir, "pr2");

    const res = await runCli(["submit", "--no-edit"]);

    expect(res.exitCode).not.toBe(0);
    const calls = await ghCalls();
    expect(calls.filter((c) => c.startsWith("pr edit 2 --base"))).toEqual([
      "pr edit 2 --base main",
      "pr edit 2 --base pr1",
    ]);
    expect(JSON.parse(await Bun.file(`${binDir}/2.json`).text()).baseRefName).toBe("pr1");
    expect((await readMetadata(tmpDir)).stacks["test-stack"]!.branches["pr2"]!.prBase).toBe("pr1");
  });
});

// #148: when the retarget before the push keeps failing, the push goes out
// anyway, and its checks run against the old base. A retarget that lands
// later, with nothing left to push, can't fix that: the run says so.
describe("a retarget that lands after the push says the checks need a new push (#148)", () => {
  const note =
    "PR #2's checks last ran against pr1, not main: a check main requires waits until pr2 is pushed again";

  /** merge --base with every retarget of PR #2 failing: pr2 is pushed, PR #2 stays on pr1. */
  async function pushedWhileOnPr1(): Promise<void> {
    await githubSquashesPr1();
    await logPushes();
    await Bun.write(`${binDir}/edit-2.fails`, "99");
    await checkout(tmpDir, "pr1");
    const res = await runCli(["merge", "--base"]);
    expect(res.exitCode).toBe(0);
    expect(await ghCalls()).toContain("push pr2");
    expect(JSON.parse(await Bun.file(`${binDir}/2.json`).text()).baseRefName).toBe("pr1");
    await fs.rm(`${binDir}/edit-2.fails`);
    await fs.rm(`${binDir}/gh.log`);
    await checkout(tmpDir, "pr2");
  }

  test("restack: nothing to push, PR #2 → main, and the note", async () => {
    await pushedWhileOnPr1();

    const res = await runCli(["restack"]);

    expect(res.exitCode).toBe(0);
    const calls = await ghCalls();
    expect(calls).toContain("pr edit 2 --base main");
    expect(calls).not.toContain("push pr2");
    expect(res.out).toContain(note);
  });

  test("submit: nothing to push, PR #2 → main, and the note", async () => {
    await pushedWhileOnPr1();

    const res = await runCli(["submit", "--no-edit"]);

    expect(res.exitCode).toBe(0);
    const calls = await ghCalls();
    expect(calls).toContain("pr edit 2 --base main");
    expect(calls).not.toContain("push pr2");
    expect(res.out).toContain(note);
  });

  test("restack: a move that fails before the push and lands after it gets the note", async () => {
    await githubSquashesPr1();
    await checkout(tmpDir, "pr1");
    expect((await runCli(["merge", "--base", "--no-push"])).exitCode).toBe(0);
    await logPushes();
    // setPrBase tries three times: all of them before the push fail.
    await Bun.write(`${binDir}/edit-2.fails`, "3");
    await fs.rm(`${binDir}/gh.log`);
    await checkout(tmpDir, "pr2");

    const res = await runCli(["restack", "--push"]);

    expect(res.exitCode).toBe(0);
    const calls = await ghCalls();
    const pushed = calls.indexOf("push pr2");
    expect(pushed).toBeGreaterThan(-1);
    expect(calls.lastIndexOf("pr edit 2 --base main")).toBeGreaterThan(pushed);
    expect(JSON.parse(await Bun.file(`${binDir}/2.json`).text()).baseRefName).toBe("main");
    expect(res.out).toContain(note);
  });

  test("a retarget made before the push gets no note", async () => {
    await githubSquashesPr1();
    await logPushes();
    await checkout(tmpDir, "pr1");

    const res = await runCli(["merge", "--base"]);
    const after = await runCli(["restack"]);

    expect(res.exitCode).toBe(0);
    expect(after.exitCode).toBe(0);
    expect(res.out + after.out).not.toContain("checks last ran against");
  });
});

// #78: the branch that becomes the new bottom is checked out in another
// worktree. The re-root and the restack of the tail run there, and merge no
// longer checks it out here.
describe("merge --base with the next branch checked out in another worktree (#78)", () => {
  const worktree = () => `${tmpDir}.worktree`;
  afterEach(async () => {
    await cleanup(worktree());
  });

  test("re-roots it in its worktree and restacks the tail from it", async () => {
    await githubSquashesPr1();
    await checkout(tmpDir, "pr1");
    await git(tmpDir, "worktree", "add", "-q", worktree(), "pr2");

    const res = await runCli(["merge", "--base"]);

    expect(res.exitCode).toBe(0);
    const squash = await remoteSha("main");
    expect(await contains(tmpDir, squash, "pr2")).toBe(true);
    expect(await contains(tmpDir, "pr2", "pr3")).toBe(true);
    expect(await remoteSha("pr3")).toBe(await git(tmpDir, "rev-parse", "pr3"));
    // The worktree followed pr2 and is still clean.
    expect(await git(worktree(), "rev-parse", "--abbrev-ref", "HEAD")).toBe("pr2");
    expect(await git(worktree(), "rev-parse", "HEAD")).toBe(await git(tmpDir, "rev-parse", "pr2"));
    expect(await git(worktree(), "status", "--porcelain")).toBe("");
  });

  test("stops before merging the PR when that worktree has uncommitted changes", async () => {
    await githubSquashesPr1();
    await checkout(tmpDir, "pr1");
    await git(tmpDir, "worktree", "add", "-q", worktree(), "pr2");
    await Bun.write(`${worktree()}/pr2.txt`, "work in progress\n");

    const res = await runCli(["merge", "--base"]);

    expect(res.exitCode).toBe(1);
    expect(res.out).toContain("Stopped before changing anything");
    expect(res.out).toContain(worktree());
    expect(await Bun.file(`${binDir}/gh.log`).text()).not.toContain("pr merge");
  });
});
