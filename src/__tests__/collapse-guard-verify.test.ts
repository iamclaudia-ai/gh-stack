// #28, primary guard: verifyCollapse checks each collapsed child's squash commit is still in
// what it was squashed into, and zeroContext makes GitHub's patch text comparable (#81).
//
// A second clone stands in for GitHub; see collapse-guard-helpers.ts.
import { describe, expect, test } from "bun:test";
import { $ } from "bun";
import {
  filesOf,
  forcePushOrphaning,
  git,
  type MergeFacts,
  moveMainOnOrigin,
  otherDir,
  remoteSha,
  squashOnGithub,
  tmpDir,
  useCollapseGuardRepos,
} from "./collapse-guard-helpers.ts";
import { verifyCollapse, zeroContext, type CommitFile } from "../lib/collapse-guard.ts";

useCollapseGuardRepos();

describe("primary guard: verifyCollapse", () => {
  /** Collapse pr3 → pr2 → pr1 on "GitHub"; returns the PR results gh would report. */
  async function collapse(): Promise<{
    results: Map<number, MergeFacts>;
    s2: string;
    s3: string;
  }> {
    const pr3Head = await remoteSha("pr3");
    const s3 = await squashOnGithub("pr3", "pr2", "Squash of PR #3 (#3)");
    const pr2Head = await remoteSha("pr2");
    const s2 = await squashOnGithub("pr2", "pr1", "Squash of PR #2 (#2)");
    const results = new Map<number, MergeFacts>([
      [3, { state: "MERGED", baseRefName: "pr2", headRefOid: pr3Head, mergeCommit: s3 }],
      [2, { state: "MERGED", baseRefName: "pr1", headRefOid: pr2Head, mergeCommit: s2 }],
    ]);
    return { results, s2, s3 };
  }

  const children = [
    { branch: "pr3", pr: 3, parent: "pr2", parentPr: 2 },
    { branch: "pr2", pr: 2, parent: "pr1", parentPr: null },
  ];

  async function verify(
    results: Map<number, MergeFacts>,
    patches = new Map<string, string>(),
    files = new Map<string, CommitFile[]>(),
  ) {
    process.chdir(tmpDir);
    return verifyCollapse({
      base: "pr1",
      trunkRef: "origin/main",
      children,
      lookup: {
        prResult: async (pr) => results.get(pr) ?? null,
        commitPatch: async (sha) => patches.get(sha) ?? null,
        commitFiles: async (sha) => files.get(sha) ?? null,
      },
    });
  }

  test("an intact collapse is covered", async () => {
    const { results } = await collapse();
    const verdicts = await verify(results);
    expect(verdicts.map((v) => `${v.child.pr}:${v.status}`)).toEqual(["3:covered", "2:covered"]);
  });

  test("#28: the base rewritten without the squash commit → PR #2 is missing", async () => {
    const { results, s2 } = await collapse();
    const patch = await git(otherDir, "format-patch", "-1", "--stdout", s2);
    const files = await filesOf(otherDir, s2);
    // A sync rewrote pr1 back to base-only and force-pushed it. The squash
    // commit is now orphaned on GitHub: not fetchable, but GitHub still has
    // its patch and file list, and neither is in pr1.
    await git(otherDir, "checkout", "-q", "pr1");
    await git(otherDir, "reset", "-q", "--hard", "HEAD~1");
    await forcePushOrphaning("pr1");

    const verdicts = await verify(results, new Map([[s2, `${patch}\n`]]), new Map([[s2, files]]));
    expect(verdicts.map((v) => `${v.child.pr}:${v.status}`)).toEqual(["3:covered", "2:missing"]);
    const pr2 = verdicts[1]!;
    if (pr2.status === "missing") expect(pr2.fetchable).toBe(false);
  });

  test("unfetchable and GitHub returns nothing: unconfirmed, never claimed missing", async () => {
    const { results } = await collapse();
    await git(otherDir, "checkout", "-q", "pr1");
    await git(otherDir, "reset", "-q", "--hard", "HEAD~1");
    await forcePushOrphaning("pr1");

    const verdicts = await verify(results);
    expect(verdicts.map((v) => `${v.child.pr}:${v.status}`)).toEqual([
      "3:covered",
      "2:unconfirmed",
    ]);
  });

  test("unfetchable, no patch, but the base tree holds every file it wrote: covered", async () => {
    const { results, s2 } = await collapse();
    const files = await filesOf(otherDir, s2);
    await moveMainOnOrigin();
    await git(otherDir, "checkout", "-q", "pr1");
    await git(otherDir, "rebase", "-q", "main");
    await forcePushOrphaning("pr1");

    const verdicts = await verify(results, new Map(), new Map([[s2, files]]));
    expect(verdicts.map((v) => `${v.child.pr}:${v.status}`)).toEqual(["3:covered", "2:covered"]);
  });

  test("a rebased copy of an unfetchable squash commit counts, via its patch from GitHub", async () => {
    const { results, s2 } = await collapse();
    const patch = await git(otherDir, "format-patch", "-1", "--stdout", s2);
    // pr1 (with the squash) rebased onto a moved main: the commit is rewritten
    // and the original is gone from the remote.
    await moveMainOnOrigin();
    await git(otherDir, "checkout", "-q", "pr1");
    await git(otherDir, "rebase", "-q", "main");
    await forcePushOrphaning("pr1");
    await git(tmpDir, "fetch", "-q", "origin", "main");

    const verdicts = await verify(results, new Map([[s2, `${patch}\n`]]));
    expect(verdicts.map((v) => `${v.child.pr}:${v.status}`)).toEqual(["3:covered", "2:covered"]);
  });

  test("a rebased copy of a squash commit we have locally counts too", async () => {
    const { results } = await collapse();
    await git(tmpDir, "fetch", "-q", "origin"); // the squash commit is now local
    await moveMainOnOrigin();
    await git(otherDir, "checkout", "-q", "pr1");
    await git(otherDir, "rebase", "-q", "main");
    await forcePushOrphaning("pr1");
    await git(tmpDir, "fetch", "-q", "origin", "main");

    const verdicts = await verify(results); // no patch from "GitHub"
    expect(verdicts.map((v) => `${v.child.pr}:${v.status}`)).toEqual(["3:covered", "2:covered"]);
  });

  /**
   * #81: PR #2 and main each add a line right after README's first, so the
   * base (holding PR #2's squash) conflicts with main. It's rebased onto main
   * with both lines kept: the squash commit is rewritten, its README differs
   * from both versions the commit knew, and its full patch has new context.
   */
  async function collapseThenRebaseThroughConflict(beforeRewrite = async () => {}) {
    await git(otherDir, "checkout", "-q", "pr2");
    await Bun.write(`${otherDir}/README.md`, "# Test Repo\npr2 line\n");
    await git(otherDir, "commit", "-q", "-am", "pr2: README line");
    await git(otherDir, "push", "-q", "origin", "pr2");
    const collapsed = await collapse();
    await beforeRewrite();
    await git(otherDir, "checkout", "-q", "main");
    await Bun.write(`${otherDir}/README.md`, "# Test Repo\nmain line\n");
    await git(otherDir, "commit", "-q", "-am", "main: README line");
    await git(otherDir, "push", "-q", "origin", "main");
    await git(otherDir, "checkout", "-q", "pr1");
    await $`git -C ${otherDir} rebase -q main`.nothrow().quiet();
    await Bun.write(`${otherDir}/README.md`, "# Test Repo\nmain line\npr2 line\n");
    await git(otherDir, "add", "README.md");
    await git(otherDir, "-c", "core.editor=true", "rebase", "--continue");
    await forcePushOrphaning("pr1");
    await git(tmpDir, "fetch", "-q", "origin", "main");
    return collapsed;
  }

  test("#81: a squash commit rebased through a conflict beside its lines still counts", async () => {
    const { results, s2 } = await collapseThenRebaseThroughConflict(async () => {
      await git(tmpDir, "fetch", "-q", "origin"); // the squash commit is now local
    });
    expect(await git(tmpDir, "cat-file", "-t", s2)).toBe("commit");
    const verdicts = await verify(results);
    expect(verdicts.map((v) => `${v.child.pr}:${v.status}`)).toEqual(["3:covered", "2:covered"]);
  });

  test("#81: the same, from GitHub's patch when the squash commit can't be fetched", async () => {
    const { results, s2 } = await collapseThenRebaseThroughConflict();
    const patch = await git(otherDir, "format-patch", "-1", "--stdout", s2);
    const verdicts = await verify(results, new Map([[s2, `${patch}\n`]]));
    expect(verdicts.map((v) => `${v.child.pr}:${v.status}`)).toEqual(["3:covered", "2:covered"]);
  });

  test("an intermediate branch merged without its child's squash → that child is missing", async () => {
    const { results } = await collapse();
    // PR #2 merged a head from before PR #3 was squashed into it.
    const pr2Before = await git(otherDir, "rev-parse", "origin/pr2~1");
    results.set(2, { ...results.get(2)!, headRefOid: pr2Before });

    const verdicts = await verify(results);
    const pr3 = verdicts.find((v) => v.child.pr === 3)!;
    expect(pr3.status).toBe("missing");
    if (pr3.status === "missing") expect(pr3.containerLabel).toBe("PR #2's merged head");
  });

  test("when GitHub can't say, it's unverified rather than a guess", async () => {
    const { results } = await collapse();
    results.delete(3);
    const verdicts = await verify(results);
    expect(verdicts.map((v) => `${v.child.pr}:${v.status}`)).toEqual(["3:unverified", "2:covered"]);
  });
});

describe("zeroContext: GitHub's patch text, patch-id'd as git diff -U0 would be (#81)", () => {
  async function patchId(text: string): Promise<string> {
    const out = await $`git patch-id --stable < ${new Response(text)}`.cwd(tmpDir).text();
    return out.trim().split(" ")[0]!;
  }

  /** Commit `after` over `before` in a.txt: the -U0 id, and the id of zeroContext(format-patch). */
  async function ids(before: string, after: string): Promise<[string, string]> {
    await Bun.write(`${tmpDir}/a.txt`, before);
    await git(tmpDir, "add", "a.txt");
    await git(tmpDir, "commit", "-q", "-m", "before");
    await Bun.write(`${tmpDir}/a.txt`, after);
    await git(tmpDir, "commit", "-q", "-am", "after");
    const u0 = await $`git -C ${tmpDir} show -U0 HEAD`.text();
    const patch = await $`git -C ${tmpDir} format-patch -1 --stdout HEAD`.text();
    expect(patch).toContain("\n-- \n"); // the signature a removed-line reader would trip on
    // Line for line what git -U0 prints, hunk headers aside, "\ No newline"
    // markers included: patch-id skips those today, but the text shouldn't
    // depend on that.
    const body = (text: string) =>
      text
        .slice(text.indexOf("diff --git"))
        .split("\n-- \n")[0]!
        .split("\n")
        .filter((line) => !line.startsWith("@@"))
        .join("\n")
        .trimEnd();
    expect(body(zeroContext(patch))).toBe(body(u0));
    return [await patchId(u0), await patchId(zeroContext(patch))];
  }

  const ten = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`);

  test("two changes inside one context hunk, and no newline at the end after a change", async () => {
    const after = [...ten];
    after[2] = "line 3 changed";
    after[5] = "line 6 changed";
    after[9] = "line 10 changed";
    const [u0, zero] = await ids(`${ten.join("\n")}\n`, after.join("\n"));
    expect(zero).toBe(u0);
  });

  test("no newline at the end of the old file (the marker sits inside the hunk)", async () => {
    const after = [...ten];
    after[9] = "line 10 changed";
    const [u0, zero] = await ids(ten.join("\n"), `${after.join("\n")}\nline 11\n`);
    expect(zero).toBe(u0);
  });

  test("no newline at the end after a context line", async () => {
    const after = [...ten];
    after.splice(8, 0, "inserted");
    const [u0, zero] = await ids(ten.join("\n"), after.join("\n"));
    expect(zero).toBe(u0);
  });

  test("context really is ignored: the same change between other lines matches", async () => {
    const [, a] = await ids("one\ntwo\n", "one\nadded\ntwo\n");
    const [, b] = await ids("uno\ndos\n", "uno\nadded\ndos\n");
    expect(b).toBe(a);
  });
});
