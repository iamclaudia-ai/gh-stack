// #28, secondary guard: restack/sync stop before rewriting a branch whose origin copy has
// commits the local branch never had (a collapse's squash commit), but not for the
// pre-rewrite versions a --no-push run leaves on origin. Also the #50 review rounds.
//
// A second clone stands in for GitHub; see collapse-guard-helpers.ts.
import { describe, expect, test } from "bun:test";
import { $ } from "bun";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { checkout, cleanup, makeCommit } from "./helpers.ts";
import {
  binDir,
  forcePushOrphaning,
  git,
  installGhStub,
  type MergeFacts,
  moveMainOnOrigin,
  otherDir,
  remoteDir,
  remoteSha,
  runCli,
  squashOnGithub,
  tmpDir,
  useCollapseGuardRepos,
  writePr,
} from "./collapse-guard-helpers.ts";
import { verifyCollapse } from "../lib/collapse-guard.ts";
import * as gitLib from "../lib/git.ts";

useCollapseGuardRepos();

describe("secondary guard: restack/sync won't rewrite past commits only origin has", () => {
  test("sync after a collapse squash landed on the base branch stops, naming the commit", async () => {
    await squashOnGithub("pr2", "pr1", "Squash of PR #2 (#2)");
    await moveMainOnOrigin();
    // The user fetched (so --force-with-lease would pass) but never pulled pr1.
    await git(tmpDir, "fetch", "-q", "origin");
    const pr1Origin = await remoteSha("pr1");
    const pr1Local = await git(tmpDir, "rev-parse", "pr1");
    await checkout(tmpDir, "pr1");

    const res = await runCli(["sync"]);

    expect(res.exitCode).toBe(1);
    expect(res.out).toContain("Origin has commits that the local branches don't");
    expect(res.out).toContain("Squash of PR #2 (#2)");
    expect(res.out).toContain("git pull --ff-only origin pr1");
    expect(res.out).toContain("--overwrite-remote");
    // Nothing was rewritten, here or on origin.
    expect(await remoteSha("pr1")).toBe(pr1Origin);
    expect(await git(tmpDir, "rev-parse", "pr1")).toBe(pr1Local);
  });

  test("restack stops when a child's origin copy has a commit pushed from elsewhere", async () => {
    await git(otherDir, "checkout", "-q", "pr2");
    await Bun.write(`${otherDir}/collab.txt`, "theirs\n");
    await git(otherDir, "add", "collab.txt");
    await git(otherDir, "commit", "-q", "-m", "collaborator's commit");
    await git(otherDir, "push", "-q", "origin", "pr2");
    await git(tmpDir, "fetch", "-q", "origin");
    const pr2Origin = await remoteSha("pr2");
    await checkout(tmpDir, "pr1");
    await makeCommit(tmpDir, "pr1-fix.txt", "fix\n", "fix on pr1");

    const res = await runCli(["restack"]);

    expect(res.exitCode).toBe(1);
    expect(res.out).toContain("collaborator's commit");
    expect(res.out).toContain("git pull --ff-only origin pr2");
    expect(await remoteSha("pr2")).toBe(pr2Origin);
  });

  test("--overwrite-remote rewrites anyway", async () => {
    const squash = await squashOnGithub("pr2", "pr1", "Squash of PR #2 (#2)");
    await moveMainOnOrigin();
    await git(tmpDir, "fetch", "-q", "origin");
    await checkout(tmpDir, "pr1");

    const res = await runCli(["sync", "--overwrite-remote"]);

    expect(res.exitCode).toBe(0);
    expect(res.out).toContain("--overwrite-remote: continuing");
    const contains = await $`git -C ${remoteDir} merge-base --is-ancestor ${squash} refs/heads/pr1`
      .nothrow()
      .quiet();
    expect(contains.exitCode).not.toBe(0);
  });

  test("no false positive: origin holding the pre-rewrite versions a --no-push run left", async () => {
    // pr1 gains a pr2.txt that conflicts with pr2's own, so pr2's rebased
    // commit is NOT patch-equivalent to the one still on origin.
    await checkout(tmpDir, "pr1");
    await makeCommit(tmpDir, "pr2.txt", "from pr1\n", "pr1: conflicting pr2.txt");
    expect((await runCli(["restack", "--no-push"])).exitCode).toBe(2);
    await Bun.write(`${tmpDir}/pr2.txt`, "resolved\n");
    await $`git -C ${tmpDir} add pr2.txt`.quiet();
    await $`git -C ${tmpDir} rebase --continue`.env({ ...process.env, GIT_EDITOR: "true" }).quiet();
    expect((await runCli(["restack", "--resume"])).exitCode).toBe(0);
    expect(await remoteSha("pr2")).not.toBe(await git(tmpDir, "rev-parse", "pr2"));

    await checkout(tmpDir, "pr1");
    const res = await runCli(["restack", "--push"]);

    expect(res.exitCode).toBe(0);
    expect(res.out).not.toContain("Origin has commits");
    for (const b of ["pr1", "pr2", "pr3"]) {
      expect(await remoteSha(b)).toBe(await git(tmpDir, "rev-parse", b));
    }
  });
});

describe("review fixes (#50)", () => {
  test("sync after merge --approved + base landed: the merged bottoms aren't guarded, sync advances", async () => {
    // PR #2 was collapsed into pr1, then PR #1 squash-merged into main.
    await squashOnGithub("pr2", "pr1", "Squash of PR #2 (#2)");
    await git(otherDir, "checkout", "-q", "main");
    await git(otherDir, "merge", "--squash", "origin/pr1");
    await git(otherDir, "commit", "-q", "-m", "PR #1 (#1)");
    await git(otherDir, "push", "-q", "origin", "main");
    for (const [n, state] of [
      [1, "MERGED"],
      [2, "MERGED"],
      [3, "OPEN"],
    ] as const) {
      await writePr(n, { number: n, title: `PR ${n}`, state, url: `https://x/${n}` });
    }
    await installGhStub();
    await git(tmpDir, "fetch", "-q", "origin");
    await checkout(tmpDir, "pr3");

    const res = await runCli(["sync"]);

    expect(res.exitCode).toBe(0);
    expect(res.out).not.toContain("Origin has commits");
    expect(await git(tmpDir, "rev-list", "--count", "origin/main..pr3")).toBe("1");
    expect(await remoteSha("pr3")).toBe(await git(tmpDir, "rev-parse", "pr3"));
  });

  test("main merged into a PR branch on GitHub (Update branch) isn't new content; restack pushes", async () => {
    await moveMainOnOrigin();
    await git(otherDir, "fetch", "-q", "origin");
    await git(otherDir, "checkout", "-q", "pr2");
    await git(otherDir, "pull", "-q", "--ff-only", "origin", "pr2");
    await git(otherDir, "merge", "-q", "--no-edit", "origin/main");
    await git(otherDir, "push", "-q", "origin", "pr2");
    // Fetched, never pulled: --force-if-includes alone would refuse this push.
    await git(tmpDir, "fetch", "-q", "origin");
    await checkout(tmpDir, "pr1");
    await makeCommit(tmpDir, "pr1-fix.txt", "fix\n", "fix on pr1");

    const res = await runCli(["restack"]);

    expect(res.exitCode).toBe(0);
    expect(res.out).not.toContain("Origin has commits");
    for (const b of ["pr1", "pr2", "pr3"]) {
      expect(await remoteSha(b)).toBe(await git(tmpDir, "rev-parse", b));
    }
  });

  test("--force-if-includes refuses to overwrite a fetched, never-integrated tip, in gh-stack terms", async () => {
    await squashOnGithub("pr2", "pr1", "Squash of PR #2 (#2)");
    await git(tmpDir, "fetch", "-q", "origin");
    await checkout(tmpDir, "pr1");
    await git(tmpDir, "commit", "-q", "--amend", "-m", "pr1: reworded");
    process.chdir(tmpDir);

    const result = await gitLib.forcePushWithLease("pr1");

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("not-integrated");
    const hint = gitLib.pushFailureHint("pr1", result).join("\n");
    expect(hint).toContain("fetched but never brought into local pr1");
    expect(hint).toContain("--overwrite-remote");
  });

  test("restack --resume --dry-run reports the guard instead of skipping it", async () => {
    await checkout(tmpDir, "pr1");
    await makeCommit(tmpDir, "pr2.txt", "from pr1\n", "pr1: conflicting pr2.txt");
    expect((await runCli(["restack", "--no-push"])).exitCode).toBe(2);
    await Bun.write(`${tmpDir}/pr2.txt`, "resolved\n");
    await $`git -C ${tmpDir} add pr2.txt`.quiet();
    await $`git -C ${tmpDir} rebase --continue`.env({ ...process.env, GIT_EDITOR: "true" }).quiet();
    await git(otherDir, "checkout", "-q", "pr3");
    await Bun.write(`${otherDir}/collab.txt`, "theirs\n");
    await git(otherDir, "add", "collab.txt");
    await git(otherDir, "commit", "-q", "-m", "collaborator's commit");
    await git(otherDir, "push", "-q", "origin", "pr3");

    const res = await runCli(["restack", "--resume", "--dry-run"]);

    expect(res.out).toContain("collaborator's commit");
    expect(res.out).toContain("[DRY RUN] A real run would stop here.");
  });
});

describe("round 3: fail closed (#50)", () => {
  /** A squash commit collapsed into pr1, as GitHub would report it. */
  async function collapsePr2(): Promise<{ results: Map<number, MergeFacts>; s2: string }> {
    const pr2Head = await remoteSha("pr2");
    const s2 = await squashOnGithub("pr2", "pr1", "Squash of PR #2 (#2)");
    return {
      results: new Map([
        [2, { state: "MERGED", baseRefName: "pr1", headRefOid: pr2Head, mergeCommit: s2 }],
      ]),
      s2,
    };
  }
  const onlyPr2 = [{ branch: "pr2", pr: 2, parent: "pr1", parentPr: null }];

  async function verifyIn(dir: string, results: Map<number, MergeFacts>) {
    process.chdir(dir);
    return verifyCollapse({
      base: "pr1",
      trunkRef: "origin/main",
      children: onlyPr2,
      lookup: {
        prResult: async (pr) => results.get(pr) ?? null,
        commitPatch: async () => null,
        commitFiles: async () => null,
      },
    });
  }

  test("a local squash commit with no proof either way is unconfirmed, not missing", async () => {
    const { results } = await collapsePr2();
    await git(tmpDir, "fetch", "-q", "origin"); // the squash commit is local
    // pr1 rewritten so its files hold a third version: neither the squash's nor the one before.
    await git(otherDir, "checkout", "-q", "pr1");
    await git(otherDir, "reset", "-q", "--hard", "HEAD~1");
    await Bun.write(`${otherDir}/pr2.txt`, "something else\n");
    await git(otherDir, "add", "pr2.txt");
    await git(otherDir, "commit", "-q", "-m", "pr1: unrelated pr2.txt");
    await forcePushOrphaning("pr1");

    const [v] = await verifyIn(tmpDir, results);
    expect(v!.status).toBe("unconfirmed");
  });

  test("a local squash commit whose files are all as they were before it is missing (proof)", async () => {
    const { results } = await collapsePr2();
    await git(tmpDir, "fetch", "-q", "origin");
    await git(otherDir, "checkout", "-q", "pr1");
    await git(otherDir, "reset", "-q", "--hard", "HEAD~1");
    await forcePushOrphaning("pr1");

    const [v] = await verifyIn(tmpDir, results);
    expect(v!.status).toBe("missing");
  });

  test("a shallow clone never reports missing because of its boundary", async () => {
    const { results } = await collapsePr2();
    // pr1 moves on past the squash, changing one of its files: a full clone
    // proves the squash is an ancestor; a depth-1 clone can't see that far.
    await git(otherDir, "checkout", "-q", "pr1");
    await Bun.write(`${otherDir}/pr2.txt`, "edited after the collapse\n");
    await git(otherDir, "add", "pr2.txt");
    await git(otherDir, "commit", "-q", "-m", "pr1: follow-up");
    await git(otherDir, "push", "-q", "origin", "pr1");
    const shallowDir = await fs.mkdtemp(path.join(await fs.realpath("/tmp"), "gh-stack-shallow-"));
    try {
      await $`git clone -q --depth 1 --no-single-branch file://${remoteDir} ${shallowDir}`.quiet();

      const [v] = await verifyIn(shallowDir, results);
      expect(v!.status).toBe("unconfirmed");
      if (v!.status === "unconfirmed") expect(v!.reason).toContain("shallow");

      const [full] = await verifyIn(tmpDir, results);
      expect(full!.status).toBe("covered");
    } finally {
      await cleanup(shallowDir);
    }
  });

  test("non-ASCII paths compare correctly (-z): a squash folded into another commit still counts", async () => {
    await checkout(tmpDir, "pr2");
    await makeCommit(tmpDir, "naïve-ü.txt", "unicode\n", "pr2: non-ASCII path");
    await git(tmpDir, "push", "-q", "origin", "pr2");
    const { results } = await collapsePr2();
    await git(tmpDir, "fetch", "-q", "origin"); // the squash commit is local
    // pr1's own commit and the squash folded into one: no ancestry, no patch-id match.
    await git(otherDir, "checkout", "-q", "pr1");
    await git(otherDir, "reset", "-q", "--soft", "HEAD~2");
    await git(otherDir, "commit", "-q", "-m", "pr1 + PR #2, folded");
    await forcePushOrphaning("pr1");

    const [v] = await verifyIn(tmpDir, results);
    expect(v!.status).toBe("covered");
  });

  test("a failed advance push is retried later, and the PR is retargeted then", async () => {
    // PR #1 merged into main on GitHub; pr2's first push is rejected once.
    await git(otherDir, "checkout", "-q", "main");
    await git(otherDir, "merge", "-q", "--squash", "origin/pr1");
    await git(otherDir, "commit", "-q", "-m", "PR #1 (#1)");
    await git(otherDir, "push", "-q", "origin", "main");
    const marker = `${remoteDir}/rejected-once`;
    await Bun.write(
      `${remoteDir}/hooks/pre-receive`,
      `#!/bin/sh
while read old new ref; do
  if [ "$ref" = "refs/heads/pr2" ] && [ ! -f "${marker}" ]; then touch "${marker}"; echo "transient" >&2; exit 1; fi
done
exit 0
`,
    );
    await fs.chmod(`${remoteDir}/hooks/pre-receive`, 0o755);
    for (const [n, state] of [
      [1, "MERGED"],
      [2, "OPEN"],
      [3, "OPEN"],
    ] as const) {
      await writePr(n, { number: n, title: `PR ${n}`, state, url: `https://x/${n}` });
    }
    await installGhStub();
    await git(tmpDir, "fetch", "-q", "origin");
    await checkout(tmpDir, "pr2");

    const res = await runCli(["sync"]);

    expect(res.out).toContain("Push of pr2 failed");
    expect(await remoteSha("pr2")).toBe(await git(tmpDir, "rev-parse", "pr2"));
    const calls = await Bun.file(`${binDir}/gh.log`).text();
    expect(calls).toContain("pr edit 2 --base main");
  });

  test("the advance push honors the guard's verified tip (explicit lease)", async () => {
    // PR #1 merged; pr2 had main merged into it on GitHub ("Update branch"),
    // which this clone fetched but never pulled.
    await git(otherDir, "checkout", "-q", "main");
    await git(otherDir, "merge", "-q", "--squash", "origin/pr1");
    await git(otherDir, "commit", "-q", "-m", "PR #1 (#1)");
    await git(otherDir, "push", "-q", "origin", "main");
    await git(otherDir, "checkout", "-q", "pr2");
    await git(otherDir, "pull", "-q", "--ff-only", "origin", "pr2");
    await git(otherDir, "merge", "-q", "--no-edit", "origin/main");
    await git(otherDir, "push", "-q", "origin", "pr2");
    for (const [n, state] of [
      [1, "MERGED"],
      [2, "OPEN"],
      [3, "OPEN"],
    ] as const) {
      await writePr(n, { number: n, title: `PR ${n}`, state, url: `https://x/${n}` });
    }
    await installGhStub();
    await git(tmpDir, "fetch", "-q", "origin");
    await checkout(tmpDir, "pr2");

    const res = await runCli(["sync"]);

    expect(res.exitCode).toBe(0);
    expect(res.out).not.toContain("Push of pr2 failed");
    expect(await remoteSha("pr2")).toBe(await git(tmpDir, "rev-parse", "pr2"));
  });

  test("a git rev-list failure in the remote guard fails closed", async () => {
    // A --no-push restack leaves origin's pr2/pr3 at their pre-rewrite versions.
    await checkout(tmpDir, "pr1");
    await makeCommit(tmpDir, "pr1-fix.txt", "fix\n", "fix on pr1");
    expect((await runCli(["restack", "--no-push"])).exitCode).toBe(0);
    const pr2Origin = await remoteSha("pr2");
    const realGit = Bun.which("git")!;
    await Bun.write(
      `${binDir}/git`,
      `#!/bin/sh
if [ -n "$FAIL_REV_LIST" ] && [ "$1" = "rev-list" ]; then echo "fatal: forced failure" >&2; exit 128; fi
exec "${realGit}" "$@"
`,
    );
    await fs.chmod(`${binDir}/git`, 0o755);

    const res = await runCli(["restack", "--push"], { GH_STACK_YES: "1", FAIL_REV_LIST: "1" });

    expect(res.exitCode).toBe(1);
    expect(res.out).toContain("git rev-list failed");
    expect(await remoteSha("pr2")).toBe(pr2Origin);
  });
});
