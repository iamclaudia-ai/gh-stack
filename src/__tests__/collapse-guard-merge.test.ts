// #28, primary guard in `merge`: before the base PR is handed to main, each collapsed child's
// squash commit must still be in what it was squashed into.
//
// A second clone stands in for GitHub; see collapse-guard-helpers.ts.
import { describe, expect, test } from "bun:test";
import { $ } from "bun";
import * as path from "node:path";
import { checkout } from "./helpers.ts";
import {
  binDir,
  filesOf,
  forcePushOrphaning,
  git,
  installGhStub,
  otherDir,
  remoteSha,
  runCli,
  squashOnGithub,
  tmpDir,
  useCollapseGuardRepos,
  writePr,
} from "./collapse-guard-helpers.ts";

useCollapseGuardRepos();

describe("primary guard: merge", () => {
  async function stackCollapsed(): Promise<string> {
    const pr3Head = await remoteSha("pr3");
    const s3 = await squashOnGithub("pr3", "pr2", "Squash of PR #3 (#3)");
    const pr2Head = await remoteSha("pr2");
    const s2 = await squashOnGithub("pr2", "pr1", "Squash of PR #2 (#2)");
    const merged = { state: "MERGED", mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN" };
    await writePr(3, {
      ...merged,
      headRefName: "pr3",
      headRefOid: pr3Head,
      baseRefName: "pr2",
      mergeCommit: { oid: s3 },
    });
    await writePr(2, {
      ...merged,
      headRefName: "pr2",
      headRefOid: pr2Head,
      baseRefName: "pr1",
      mergeCommit: { oid: s2 },
    });
    await writePr(1, {
      state: "OPEN",
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
      headRefName: "pr1",
      headRefOid: await remoteSha("pr1"),
      baseRefName: "main",
      mergeCommit: null,
    });
    await installGhStub();
    await checkout(tmpDir, "pr1");
    return s2;
  }

  /** On "GitHub": rewrite pr1 back to base-only, orphaning the squash commit. */
  async function rewriteBaseWithoutSquash(): Promise<void> {
    await git(otherDir, "checkout", "-q", "pr1");
    await git(otherDir, "reset", "-q", "--hard", "HEAD~1");
    await forcePushOrphaning("pr1");
  }

  test("re-running merge after the base was rewritten stops before auto-merge, naming the PR", async () => {
    const s2 = await stackCollapsed();
    await Bun.write(
      `${binDir}/patch-${s2}`,
      await git(otherDir, "format-patch", "-1", "--stdout", s2),
    );
    await Bun.write(`${binDir}/files-${s2}`, JSON.stringify(await filesOf(otherDir, s2)));
    await rewriteBaseWithoutSquash();

    const res = await runCli(["merge"]);

    expect(res.exitCode).toBe(2);
    expect(res.out).toContain("PR #2 (pr2)'s changes are missing from PR #1");
    expect(res.out).toContain("Nothing was merged to main");
    // The squash commit can't be fetched, so the fix leads with its patch.
    expect(res.out).toContain(
      `gh api -H "Accept: application/vnd.github.patch" repos/acme/widgets/commits/${s2} | git am`,
    );
    expect(res.out).not.toContain(`git fetch origin ${s2}`);
    const calls = await Bun.file(`${binDir}/gh.log`).text();
    expect(calls).not.toContain("--auto");
  });

  test("when the content can't be checked, --yes stops as UNVERIFIED (not missing)", async () => {
    await stackCollapsed();
    await rewriteBaseWithoutSquash(); // and GitHub serves neither patch nor files

    const res = await runCli(["merge"]);

    expect(res.exitCode).toBe(2);
    expect(res.out).toContain("UNVERIFIED, not known to be missing");
    expect(res.out).toContain("gh-stack merge --skip-collapse-check");
    expect(res.out).not.toContain("changes are missing from");
    const calls = await Bun.file(`${binDir}/gh.log`).text();
    expect(calls).not.toContain("--auto");
  });

  test("a GitHub failure during the check stops merge --yes (exit 2), never auto-merges", async () => {
    await stackCollapsed();
    // PR #2's 3rd `gh pr view` (the guard's, after the plan and the loop) fails.
    const res = await runCli(["merge"], { GH_STACK_YES: "1", GH_FAIL_VIEW: "2:3" });

    expect(res.exitCode).toBe(2);
    expect(res.out).toContain("Could not confirm PR #2 (pr2)'s changes are in PR #1");
    expect(res.out).toContain("couldn't read PR #2 from GitHub");
    expect(res.out).toContain("gh-stack merge --skip-collapse-check");
    const calls = await Bun.file(`${binDir}/gh.log`).text();
    expect(calls).not.toContain("--auto");
  });

  test("the hand-check steps list every child that couldn't be confirmed", async () => {
    await stackCollapsed();
    const res = await runCli(["merge"], { GH_STACK_YES: "1", GH_FAIL_VIEW: "2:3,3:3" });

    expect(res.exitCode).toBe(2);
    expect(res.out).toContain("gh pr diff 2 --name-only");
    expect(res.out).toContain("gh pr diff 3 --name-only");
  });

  test("merge --base checks a base that carries collapsed PRs, and won't merge it without them", async () => {
    await stackCollapsed();
    await rewriteBaseWithoutSquash();

    const res = await runCli(["merge", "--base"]);

    expect(res.exitCode).toBe(2);
    expect(res.out).toContain("PR #2 (pr2)");
    const calls = await Bun.file(`${binDir}/gh.log`).text();
    expect(calls).not.toContain("pr merge 1");
  });

  test("an intact collapse goes on to enable auto-merge", async () => {
    await stackCollapsed();

    const res = await runCli(["merge"]);

    expect(res.exitCode).toBe(0);
    expect(res.out).toContain("PR #1 holds every collapsed PR's changes");
    const calls = await Bun.file(`${binDir}/gh.log`).text();
    expect(calls).toContain("pr merge 1 --squash --auto");
  });

  test("#81: when the base conflicts with main, the advice says sync rebases only the base", async () => {
    await stackCollapsed();
    await writePr(1, {
      state: "OPEN",
      mergeable: "CONFLICTING",
      mergeStateStatus: "DIRTY",
      headRefName: "pr1",
      headRefOid: await remoteSha("pr1"),
      baseRefName: "main",
      mergeCommit: null,
    });

    const res = await runCli(["merge"]);

    expect(res.exitCode).toBe(2);
    expect(res.out).toContain("pr1 conflicts with main");
    expect(res.out).toContain("gh-stack sync");
    expect(res.out).toContain("(only pr1: the PRs squashed into it are dropped from the stack)");
  });

  test("#81: with main checked out in another worktree, merge says where rather than failing to sync", async () => {
    await stackCollapsed();
    const mainWorktree = path.join(binDir, "main-wt");
    await $`git -C ${tmpDir} worktree add -q ${mainWorktree} main`.quiet();

    const res = await runCli(["merge"]);

    expect(res.exitCode).toBe(0);
    expect(res.out).toContain(`main is checked out in the worktree at ${mainWorktree}`);
    expect(res.out).toContain(`git -C ${mainWorktree} pull --ff-only`);
    expect(res.out).not.toContain("Could not sync local branches");
  });
});
