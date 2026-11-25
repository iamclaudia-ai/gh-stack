// #107: `delete` removes the remote branch through the GitHub API, as
// `merge -d` does, not with `git push --delete`: that push runs the repo's
// pre-push hook, which in many repos is a full lint and test run.
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { $ } from "bun";
import * as fs from "node:fs/promises";
import {
  cleanup,
  createBranch,
  createTempRepo,
  makeCommit,
  PR_BASE_STUB,
  pushAllBranches,
  readMetadata,
  setupRemote,
  writeMetadata,
} from "./helpers.ts";
import type { Stack } from "../types.ts";

setDefaultTimeout(60_000);

let tmpDir: string;
let remoteDir: string;
let stubDir: string;

const cliPath = new URL("../index.ts", import.meta.url).pathname;

/** main → parent → feat/mid → child, stack "deps". The slash checks the ref path. */
const DEPS: Stack = {
  description: "",
  last_branch: "child",
  base: "main",
  branches: {
    parent: { parent: "main", pr: 141 },
    "feat/mid": { parent: "parent", pr: 142 },
    child: { parent: "feat/mid", pr: 143 },
  },
};

async function runCli(args: string[]) {
  const proc = Bun.spawn(["bun", "run", cliPath, ...args], {
    cwd: tmpDir,
    env: {
      ...process.env,
      PATH: `${stubDir}:${process.env.PATH}`,
      GH_PR_DIR: stubDir,
      NO_COLOR: "1",
      GH_STACK_NO_COLOR: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, out: stdout + stderr };
}

async function refExists(dir: string, ref: string): Promise<boolean> {
  const r = await $`git -C ${dir} rev-parse --verify --quiet ${ref}`.nothrow().quiet();
  return r.exitCode === 0;
}

/** Remove a ref in a fixture repo (the bare origin, or the clone). */
async function dropRef(dir: string, ref: string): Promise<void> {
  await $`git -C ${dir} update-ref -d ${ref}`.quiet();
}

async function ghCalls(): Promise<string[]> {
  const log = Bun.file(`${stubDir}/calls.log`);
  if (!(await log.exists())) return [];
  return (await log.text()).split("\n").filter(Boolean);
}

/** True when the repo's pre-push hook ran (it records itself, then refuses the push). */
async function hookRan(): Promise<boolean> {
  return Bun.file(`${stubDir}/hook-ran`).exists();
}

beforeEach(async () => {
  tmpDir = await createTempRepo();
  stubDir = await fs.mkdtemp(`${await fs.realpath("/tmp")}/gh-stack-delstub-`);
  await createBranch(tmpDir, "parent", "main");
  await makeCommit(tmpDir, "parent.txt", "parent\n", "parent: commit");
  await createBranch(tmpDir, "feat/mid", "parent");
  await makeCommit(tmpDir, "mid.txt", "mid\n", "mid: commit");
  await createBranch(tmpDir, "child", "feat/mid");
  await makeCommit(tmpDir, "child.txt", "child\n", "child: commit");
  await $`git -C ${tmpDir} checkout -q main`.quiet();
  remoteDir = await setupRemote(tmpDir);
  await pushAllBranches(tmpDir);
  await writeMetadata(tmpDir, { version: 2, current_stack: "deps", stacks: { deps: DEPS } });
  expect((await runCli(["doctor"])).exitCode).toBe(0);

  // A pre-push hook that fails, like a red test suite, and records that it ran.
  // core.hooksPath keeps a global hooksPath from hiding it.
  await fs.mkdir(`${stubDir}/hooks`);
  await Bun.write(`${stubDir}/hooks/pre-push`, `#!/bin/sh\ntouch "${stubDir}/hook-ran"\nexit 1\n`);
  await fs.chmod(`${stubDir}/hooks/pre-push`, 0o755);
  await $`git -C ${tmpDir} config core.hooksPath ${stubDir}/hooks`.quiet();

  // The fake gh: logs each call; $GH_PR_DIR/api.fail makes the API delete fail.
  await Bun.write(
    `${stubDir}/gh`,
    `#!/bin/sh
echo "$*" >> "$GH_PR_DIR/calls.log"
if [ "$1" = "api" ] && [ -f "$GH_PR_DIR/api.fail" ]; then
  echo "gh: Resource not accessible by integration (HTTP 403)" >&2
  exit 1
fi
if [ "$1 $2" = "pr list" ] && [ -f "$GH_PR_DIR/list.fail" ]; then
  echo "error connecting to api.github.com" >&2
  exit 1
fi
${PR_BASE_STUB}
exit 1
`,
  );
  await fs.chmod(`${stubDir}/gh`, 0o755);

  // child's open PR targets feat/mid, as on GitHub (PR_BASE_STUB reads these).
  await writePr(143, { state: "OPEN", baseRefName: "feat/mid" });
});

async function writePr(n: number, data: { state: string; baseRefName: string }) {
  await Bun.write(`${stubDir}/${n}.json`, JSON.stringify(data));
}

async function prBase(n: number): Promise<string> {
  return JSON.parse(await Bun.file(`${stubDir}/${n}.json`).text()).baseRefName;
}

afterEach(async () => {
  await cleanup(tmpDir, remoteDir, stubDir);
});

describe("gh-stack delete, remote branch", () => {
  test("deletes origin's copy through the API, without running the pre-push hook", async () => {
    expect(await refExists(tmpDir, "refs/remotes/origin/feat/mid")).toBe(true);

    const res = await runCli(["delete", "feat/mid", "--yes"]);

    expect(res.exitCode).toBe(0);
    expect(res.out).toContain("Deleted remote branch origin/feat/mid");
    expect(res.out).toContain("Deleted local branch feat/mid");
    expect(await ghCalls()).toContain(
      "api --method DELETE repos/{owner}/{repo}/git/refs/heads/feat/mid",
    );
    expect(await hookRan()).toBe(false);
    expect(await refExists(remoteDir, "refs/heads/feat/mid")).toBe(false);
    // The remote-tracking ref goes too, as with git push --delete.
    expect(await refExists(tmpDir, "refs/remotes/origin/feat/mid")).toBe(false);
    expect(await refExists(tmpDir, "refs/heads/feat/mid")).toBe(false);
    const branches = (await readMetadata(tmpDir)).stacks["deps"]!.branches;
    expect(Object.keys(branches).toSorted()).toEqual(["child", "parent"]);
    expect(branches["child"]!.parent).toBe("parent");
  });

  test("an API failure is reported with gh's message and keeps origin's copy", async () => {
    await Bun.write(`${stubDir}/api.fail`, "");

    const res = await runCli(["delete", "feat/mid", "--yes"]);

    expect(res.exitCode).toBe(0);
    expect(res.out).toContain(
      "Could not delete remote branch origin/feat/mid on GitHub (gh: Resource not accessible by integration (HTTP 403))",
    );
    expect(await hookRan()).toBe(false);
    expect(await refExists(remoteDir, "refs/heads/feat/mid")).toBe(true);
    expect(await refExists(tmpDir, "refs/remotes/origin/feat/mid")).toBe(true);
    // The local branch and the metadata go regardless, as before.
    expect(await refExists(tmpDir, "refs/heads/feat/mid")).toBe(false);
    expect(Object.keys((await readMetadata(tmpDir)).stacks["deps"]!.branches)).not.toContain(
      "feat/mid",
    );
  });

  test("--no-remote leaves origin alone and never calls the API", async () => {
    const res = await runCli(["delete", "feat/mid", "--no-remote", "--yes"]);

    expect(res.exitCode).toBe(0);
    expect((await ghCalls()).filter((c) => c.startsWith("api"))).toEqual([]);
    expect(await refExists(remoteDir, "refs/heads/feat/mid")).toBe(true);
    expect(await refExists(tmpDir, "refs/remotes/origin/feat/mid")).toBe(true);
    expect(await refExists(tmpDir, "refs/heads/feat/mid")).toBe(false);
    // origin keeps the branch, so the child's PR can stay on it.
    expect((await ghCalls()).filter((c) => c.startsWith("pr edit"))).toEqual([]);
    expect(await prBase(143)).toBe("feat/mid");
  });
});

// #112: GitHub closes a PR whose base branch is deleted, and won't reopen it
// once its head is pushed again. delete moves the children's PRs first.
describe("gh-stack delete, the children's PRs", () => {
  test("retargets the child's PR to the new parent before deleting origin's copy", async () => {
    const res = await runCli(["delete", "feat/mid", "--yes"]);

    expect(res.exitCode).toBe(0);
    expect(res.out).toContain("PR #143 (child) base → parent");
    expect(res.out).toContain(
      "child is still built on feat/mid's commits, so its PR lists them now",
    );
    // A move onto a branch that isn't the trunk needs no new check run (#162).
    expect(res.out).not.toContain("checks last ran against");
    expect(await prBase(143)).toBe("parent");
    // Recorded, so restack and submit don't repeat the edit.
    expect((await readMetadata(tmpDir)).stacks["deps"]!.branches["child"]!.prBase).toBe("parent");
    const calls = await ghCalls();
    const edit = calls.indexOf("pr edit 143 --base parent");
    const del = calls.indexOf("api --method DELETE repos/{owner}/{repo}/git/refs/heads/feat/mid");
    expect(edit).toBeGreaterThanOrEqual(0);
    expect(del).toBeGreaterThan(edit);
    expect(await refExists(remoteDir, "refs/heads/feat/mid")).toBe(false);
  });

  test("a failed retarget keeps origin's copy and names the PR", async () => {
    await Bun.write(`${stubDir}/edit-143.fails`, "99");

    const res = await runCli(["delete", "feat/mid", "--yes"]);

    expect(res.exitCode).toBe(0);
    expect(res.out).toContain(
      "Could not retarget PR #143 (child) to parent (GraphQL: Something went wrong (updatePullRequest))",
    );
    expect(res.out).toContain("Kept feat/mid: PR #143 still targets it");
    expect(res.out).not.toContain("lists them now");
    expect(res.out).not.toContain("checks last ran against");
    expect((await ghCalls()).filter((c) => c.startsWith("api"))).toEqual([]);
    expect(await refExists(remoteDir, "refs/heads/feat/mid")).toBe(true);
    expect(await refExists(tmpDir, "refs/remotes/origin/feat/mid")).toBe(true);
    // The local branch and the metadata still go: the PR only needs origin's copy.
    expect(await refExists(tmpDir, "refs/heads/feat/mid")).toBe(false);
    const child = (await readMetadata(tmpDir)).stacks["deps"]!.branches["child"]!;
    expect(child.parent).toBe("parent");
    // Not recorded as moved, so the next submit retries the retarget.
    expect(child.prBase).toBeUndefined();
  });

  test("another open PR on the branch keeps origin's copy, and isn't moved", async () => {
    await writePr(200, { state: "OPEN", baseRefName: "feat/mid" });

    const res = await runCli(["delete", "feat/mid", "--yes"]);

    expect(res.exitCode).toBe(0);
    expect(res.out).toContain("Kept feat/mid: PR #200 still targets it");
    expect(await prBase(143)).toBe("parent");
    expect(await prBase(200)).toBe("feat/mid");
    expect(await refExists(remoteDir, "refs/heads/feat/mid")).toBe(true);
  });

  test("a PR moved onto a branch with a slash in its name records that base (#171)", async () => {
    // leaf (PR #145) on child: deleting child moves #145 onto feat/mid.
    await createBranch(tmpDir, "leaf", "child");
    await makeCommit(tmpDir, "leaf.txt", "leaf\n", "leaf: commit");
    await $`git -C ${tmpDir} checkout -q main`.quiet();
    await $`git -C ${tmpDir} push -q --no-verify origin leaf`.quiet();
    await writeMetadata(tmpDir, {
      version: 2,
      current_stack: "deps",
      stacks: {
        deps: { ...DEPS, branches: { ...DEPS.branches, leaf: { parent: "child", pr: 145 } } },
      },
    });
    expect((await runCli(["doctor"])).exitCode).toBe(0);
    await writePr(145, { state: "OPEN", baseRefName: "child" });

    const res = await runCli(["delete", "child", "--yes"]);

    expect(res.exitCode).toBe(0);
    expect(res.out).toContain("PR #145 (leaf) base → feat/mid");
    expect(await prBase(145)).toBe("feat/mid");
    // No PR still targets child, so origin's copy goes.
    expect(res.out).not.toContain("still targets it");
    expect(await refExists(remoteDir, "refs/heads/child")).toBe(false);
  });
});

// #171: the fake gh itself. A base with a slash broke its sed, and the edit
// still exited 0 with the old base kept.
describe("PR_BASE_STUB", () => {
  async function gh(...args: string[]) {
    const proc = Bun.spawn([`${stubDir}/gh`, ...args], {
      env: { ...process.env, GH_PR_DIR: stubDir },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    return { exitCode, out: stdout };
  }

  test("pr edit --base records a base with a slash, &, | or a dot", async () => {
    for (const base of ["feat/a/b", "fix/a&b", "x|y", "v1.2"]) {
      expect((await gh("pr", "edit", "143", "--base", base)).exitCode).toBe(0);
      expect(await prBase(143)).toBe(base);
      expect((await gh("pr", "list", "--base", base)).out).toBe("143\n");
    }
  });

  test("pr list --base matches the name exactly, not as a pattern", async () => {
    await writePr(150, { state: "OPEN", baseRefName: "v1x2" });

    expect((await gh("pr", "list", "--base", "v1.2")).out).toBe("");
    expect((await gh("pr", "list", "--base", "v1x2")).out).toBe("150\n");
  });

  test("pr edit --base fails when it can't record the base", async () => {
    await fs.chmod(stubDir, 0o555);
    try {
      expect((await gh("pr", "edit", "143", "--base", "parent")).exitCode).not.toBe(0);
    } finally {
      await fs.chmod(stubDir, 0o755);
    }
    expect(await prBase(143)).toBe("feat/mid");
  });

  test("pr edit on a PR the stub doesn't track succeeds and records nothing", async () => {
    expect((await gh("pr", "edit", "999", "--base", "parent")).exitCode).toBe(0);
    expect(await Bun.file(`${stubDir}/999.json`).exists()).toBe(false);
  });
});

// #114: origin lost the branch already (deleted on GitHub); the tracking ref
// would linger until the next fetch --prune.
describe("gh-stack delete, stale tracking ref", () => {
  beforeEach(async () => {
    await dropRef(remoteDir, "refs/heads/feat/mid");
    expect(await refExists(tmpDir, "refs/remotes/origin/feat/mid")).toBe(true);
  });

  test("drops origin/<branch> when GitHub no longer has the branch", async () => {
    const res = await runCli(["delete", "feat/mid", "--yes"]);

    expect(res.exitCode).toBe(0);
    expect(res.out).toContain("Dropped stale tracking ref origin/feat/mid");
    expect(await refExists(tmpDir, "refs/remotes/origin/feat/mid")).toBe(false);
    expect(await refExists(tmpDir, "refs/heads/feat/mid")).toBe(false);
    expect((await ghCalls()).filter((c) => c.startsWith("api"))).toEqual([]);
  });

  test("drops it even when no local branch is left", async () => {
    await dropRef(tmpDir, "refs/heads/feat/mid");

    const res = await runCli(["delete", "feat/mid", "--yes"]);

    expect(res.exitCode).toBe(0);
    expect(res.out).not.toContain("No git branch found");
    expect(await refExists(tmpDir, "refs/remotes/origin/feat/mid")).toBe(false);
    // The missing branch doesn't make delete refuse: removing it is the fix.
    const branches = (await readMetadata(tmpDir)).stacks["deps"]!.branches;
    expect(Object.keys(branches).toSorted()).toEqual(["child", "parent"]);
  });

  test("--no-remote leaves the tracking ref alone", async () => {
    const res = await runCli(["delete", "feat/mid", "--no-remote", "--yes"]);

    expect(res.exitCode).toBe(0);
    expect(await refExists(tmpDir, "refs/remotes/origin/feat/mid")).toBe(true);
  });

  test("--keep-branch leaves the tracking ref alone", async () => {
    const res = await runCli(["delete", "feat/mid", "--keep-branch", "--yes"]);

    expect(res.exitCode).toBe(0);
    expect(await refExists(tmpDir, "refs/remotes/origin/feat/mid")).toBe(true);
    expect(await refExists(tmpDir, "refs/heads/feat/mid")).toBe(true);
  });
});

// #118: `ls-remote origin mid` is a pattern that matched refs/heads/feat/mid,
// so a branch origin never had was taken for present.
describe("gh-stack delete, a name that's a suffix of another remote branch", () => {
  test("`mid` isn't found through origin's feat/mid", async () => {
    await createBranch(tmpDir, "mid", "main");
    await makeCommit(tmpDir, "solo.txt", "solo\n", "mid: commit");
    await $`git -C ${tmpDir} checkout -q main`.quiet();
    // Origin has no mid, but a tracking ref lingers (as after GitHub deleted it):
    // dropping it shows delete got "absent", not just "no calls made".
    await $`git -C ${tmpDir} update-ref refs/remotes/origin/mid mid`.quiet();
    await writeMetadata(tmpDir, {
      version: 2,
      current_stack: "deps",
      stacks: {
        deps: DEPS,
        solo: {
          description: "",
          last_branch: "mid",
          base: "main",
          branches: { mid: { parent: "main" } },
        },
      },
    });
    expect((await runCli(["doctor"])).exitCode).toBe(0);

    const res = await runCli(["delete", "mid", "--yes"]);

    expect(res.exitCode).toBe(0);
    expect(res.out).toContain("Dropped stale tracking ref origin/mid");
    expect(res.out).not.toContain("remote branch origin/mid");
    expect(await ghCalls()).toEqual([]);
    expect(await refExists(tmpDir, "refs/remotes/origin/mid")).toBe(false);
    expect(await refExists(tmpDir, "refs/heads/mid")).toBe(false);
    // feat/mid is untouched on both sides.
    expect(await refExists(remoteDir, "refs/heads/feat/mid")).toBe(true);
    expect(await refExists(tmpDir, "refs/remotes/origin/feat/mid")).toBe(true);
  });
});

describe("gh-stack delete, when GitHub or origin can't be asked", () => {
  test("an unreachable origin isn't taken for a deleted branch", async () => {
    // ls-remote exits 128 here (unreachable), not 2 (no such branch).
    await $`git -C ${tmpDir} remote set-url origin /nonexistent/gh-stack-origin`.quiet();

    const res = await runCli(["delete", "feat/mid", "--yes"]);

    expect(res.exitCode).toBe(0);
    expect(res.out).toContain(
      "Couldn't reach origin, so origin/feat/mid is left as it is: it may still be on GitHub, with PRs on it",
    );
    expect(res.out).not.toContain("no longer has it");
    expect(res.out).not.toContain("Dropped stale tracking ref");
    expect(await refExists(tmpDir, "refs/remotes/origin/feat/mid")).toBe(true);
    expect(await ghCalls()).toEqual([]);
    expect(await refExists(remoteDir, "refs/heads/feat/mid")).toBe(true);
  });

  test("a failed `gh pr list` keeps origin's copy", async () => {
    await Bun.write(`${stubDir}/list.fail`, "");

    const res = await runCli(["delete", "feat/mid", "--yes"]);

    expect(res.exitCode).toBe(0);
    expect(res.out).toContain("Kept feat/mid: couldn't ask GitHub whether a PR still targets it");
    expect((await ghCalls()).filter((c) => c.startsWith("api"))).toEqual([]);
    expect(await refExists(remoteDir, "refs/heads/feat/mid")).toBe(true);
  });
});

describe("gh-stack delete, scope of the missing-branch exemption", () => {
  test("another stack branch missing locally still refuses, and origin is left alone", async () => {
    await dropRef(tmpDir, "refs/heads/child");

    const res = await runCli(["delete", "feat/mid", "--yes"]);

    expect(res.exitCode).toBe(1);
    expect(res.out).toContain("Invalid stack metadata");
    expect(await ghCalls()).toEqual([]);
    expect(await refExists(remoteDir, "refs/heads/feat/mid")).toBe(true);
    expect(await refExists(tmpDir, "refs/heads/feat/mid")).toBe(true);
  });
});

describe("gh-stack delete, a root with two children", () => {
  /** parent (PR #142 on main) with two children: feat/mid (#143) and sib (#144). */
  async function twoChildren(): Promise<void> {
    await createBranch(tmpDir, "sib", "parent");
    await makeCommit(tmpDir, "sib.txt", "sib\n", "sib: commit");
    await $`git -C ${tmpDir} checkout -q main`.quiet();
    await $`git -C ${tmpDir} push -q --no-verify origin sib`.quiet();
    await writeMetadata(tmpDir, {
      version: 2,
      current_stack: "deps",
      stacks: {
        deps: { ...DEPS, branches: { ...DEPS.branches, sib: { parent: "parent", pr: 144 } } },
      },
    });
    expect((await runCli(["doctor"])).exitCode).toBe(0);
    await writePr(142, { state: "OPEN", baseRefName: "parent" });
    await writePr(144, { state: "OPEN", baseRefName: "parent" });
  }

  test("moves both PRs to the base and records prBase in each resulting stack", async () => {
    await twoChildren();

    const res = await runCli(["delete", "parent", "--yes"]);

    expect(res.exitCode).toBe(0);
    expect(await prBase(142)).toBe("main");
    expect(await prBase(144)).toBe("main");
    // Moved onto the trunk with nothing pushed: their checks ran against parent (#162).
    for (const [pr, branch] of [
      [142, "feat/mid"],
      [144, "sib"],
    ]) {
      expect(res.out).toContain(
        `PR #${pr}'s checks last ran against parent, not main: a check main requires waits until ${branch} is pushed again`,
      );
    }
    expect(await refExists(remoteDir, "refs/heads/parent")).toBe(false);
    // feat/mid keeps "deps"; sib splits off into a stack of its own.
    const meta = await readMetadata(tmpDir);
    const entry = (b: string) => Object.values(meta.stacks).find((s) => s.branches[b])?.branches[b];
    expect(Object.values(meta.stacks).filter((s) => s.branches["sib"]).length).toBe(1);
    expect(meta.stacks["deps"]!.branches["sib"]).toBeUndefined();
    expect(entry("feat/mid")!.prBase).toBe("main");
    expect(entry("sib")!.prBase).toBe("main");
  });

  test("only the PR that moved gets the checks note (#162)", async () => {
    await twoChildren();
    await Bun.write(`${stubDir}/edit-144.fails`, "99");

    const res = await runCli(["delete", "parent", "--yes"]);

    expect(res.exitCode).toBe(0);
    expect(await prBase(142)).toBe("main");
    expect(res.out).toContain("Could not retarget PR #144 (sib) to main");
    expect(res.out).toContain("PR #142's checks last ran against parent, not main");
    expect(res.out).not.toContain("PR #144's checks last ran against");
  });
});
