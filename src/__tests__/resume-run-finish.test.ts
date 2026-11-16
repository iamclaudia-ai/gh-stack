// #82: a bare restack/sync finishes the pending run, says so, goes back to the start branch,
// then does its own job.
import { describe, expect, test } from "bun:test";
import {
  checkout,
  createBranch,
  createLinearStack,
  makeCommit,
  pushAllBranches,
  writeMetadata,
} from "./helpers.ts";
import {
  addRemote,
  advanceMain,
  currentBranch,
  isAncestor,
  remoteSha,
  runCli,
  savedState,
  sha,
  stackNeedingRestack,
  syncStoppedOnConflictThenContinued,
  tmpDir,
  useResumeRunRepos,
  writeState,
} from "./resume-run-helpers.ts";

useResumeRunRepos();

describe("a bare restack/sync finishes the pending run, then does its own job (#82)", () => {
  test("sync --no-push over a restack held at its push step: says nothing changed, then syncs (ad464f83)", async () => {
    await createLinearStack(tmpDir);
    await addRemote();
    await pushAllBranches(tmpDir);
    // Another session's restack got past every rebase and held pr2's push
    // back; pr2 has been on origin at that commit all along.
    await writeState({
      current_index: 3,
      push_only: ["pr1"],
      push: true,
      log: [{ at: new Date().toISOString(), branch: "pr2", action: "push-held", detail: "pr1" }],
    });
    await advanceMain();
    await checkout(tmpDir, "pr1");
    const before = {
      pr1: await remoteSha("pr1"),
      pr2: await remoteSha("pr2"),
      pr3: await remoteSha("pr3"),
    };

    const res = await runCli(["sync", "--no-push"]);

    expect(res.exitCode).toBe(0);
    expect(res.out).toContain("(auto-yes: finishing it, then the sync)");
    expect(res.out).toMatch(
      /Finished the interrupted restack, started [\d-]+ [\d:]+: nothing changed/,
    );
    expect(res.out).not.toContain("Stack Restack Complete");
    expect(res.out).not.toContain("isn't in a stack");
    expect(res.out).toContain("Now the sync you ran, from pr1:");
    // The sync really ran, onto the main that moved...
    expect(await isAncestor("origin/main", "pr1")).toBe(true);
    expect(await isAncestor("pr1", "pr2")).toBe(true);
    expect(await isAncestor("pr2", "pr3")).toBe(true);
    // ...and stayed local, as asked.
    expect(res.out).toContain("Not pushed (--no-push)");
    for (const b of ["pr1", "pr2", "pr3"] as const) expect(await remoteSha(b)).toBe(before[b]);
    expect((await savedState())?.command).toBe("sync");
    expect((await savedState())?.finished_at).toBeTruthy();
  });

  test("after finishing an interrupted sync it syncs again: main may have moved since", async () => {
    await syncStoppedOnConflictThenContinued();
    await advanceMain();

    const res = await runCli(["sync"]);

    expect(res.exitCode).toBe(0);
    expect(res.out).toMatch(/Finished the interrupted sync, started [\d-]+ [\d:]+\n/);
    expect(res.out).toContain("Now the sync you ran, from pr1:");
    expect(await isAncestor("origin/main", "pr1")).toBe(true);
    expect(await isAncestor("pr1", "pr2")).toBe(true);
    expect(await isAncestor("pr2", "pr3")).toBe(true);
    // The resumed run pushed, so the sync does too.
    for (const b of ["pr1", "pr2", "pr3"]) expect(await remoteSha(b)).toBe(await sha(b));
  });

  test("a local-only run stays local through the sync that follows it", async () => {
    await syncStoppedOnConflictThenContinued(["--no-push"]);
    await advanceMain();
    const before = {
      pr1: await remoteSha("pr1"),
      pr2: await remoteSha("pr2"),
      pr3: await remoteSha("pr3"),
    };

    const res = await runCli(["sync"]);

    expect(res.exitCode).toBe(0);
    expect(res.out).toContain("Now the sync you ran, from pr1:");
    expect(await isAncestor("origin/main", "pr1")).toBe(true);
    expect(res.out).toContain("Not pushed (resumed a local-only run; its push decision is kept)");
    for (const b of ["pr1", "pr2", "pr3"] as const) expect(await remoteSha(b)).toBe(before[b]);
  });

  test("a bare restack the finished run didn't cover runs from the start branch, pushing as that run did", async () => {
    await stackNeedingRestack(); // on pr1, which has a new commit
    // A local-only restack from pr2 finished its rebases; pr1 isn't in its chain.
    await writeState({ chain: ["pr2", "pr3"], push_only: [], current_index: 2, push: false });
    const before = {
      pr1: await remoteSha("pr1"),
      pr2: await remoteSha("pr2"),
      pr3: await remoteSha("pr3"),
    };

    const res = await runCli(["restack"]);

    expect(res.exitCode).toBe(0);
    expect(res.out).toMatch(
      /Finished the interrupted restack, started [\d-]+ [\d:]+: nothing changed/,
    );
    expect(res.out).toContain("Now the restack you ran, from pr1:");
    expect(res.out).not.toContain("covered the restack");
    expect(await isAncestor("pr1", "pr2")).toBe(true);
    expect(await isAncestor("pr2", "pr3")).toBe(true);
    expect(res.out).toContain("Not pushed (resumed a local-only run; its push decision is kept)");
    for (const b of ["pr1", "pr2", "pr3"] as const) expect(await remoteSha(b)).toBe(before[b]);
  });

  test("after another stack's run, sync goes back to the start branch and syncs its stack", async () => {
    const { meta } = await createLinearStack(tmpDir);
    await createBranch(tmpDir, "other", "main");
    await makeCommit(tmpDir, "other.txt", "other\n", "other: add file");
    meta.stacks["other-stack"] = {
      description: "Other stack",
      last_branch: "other",
      branches: { other: { parent: "main", pr: 4, description: "PR 4" } },
    };
    await writeMetadata(tmpDir, meta);
    await addRemote();
    await pushAllBranches(tmpDir);
    // test-stack's run stopped before restacking pr2/pr3 onto a new pr1 commit.
    await checkout(tmpDir, "pr1");
    await makeCommit(tmpDir, "pr1-fix.txt", "fix\n", "fix on pr1");
    await writeState({ current_index: 1, push_only: ["pr1"] });
    await advanceMain();
    await checkout(tmpDir, "other");

    const res = await runCli(["sync"]);

    expect(res.exitCode).toBe(0);
    // The resume restacked test-stack (leaving the checkout on its branches)...
    expect(await isAncestor("pr1", "pr2")).toBe(true);
    expect(await isAncestor("pr2", "pr3")).toBe(true);
    // ...then the sync ran on other-stack, from "other", and only there.
    expect(res.out).toContain("Now the sync you ran, from other:");
    expect(await currentBranch()).toBe("other");
    expect(await isAncestor("origin/main", "other")).toBe(true);
    expect(await isAncestor("origin/main", "pr1")).toBe(false);
  });

  test("run from a branch in no stack, it finishes the run and stops there", async () => {
    await stackNeedingRestack();
    await writeState({ current_index: 1, push_only: ["pr1"] });
    await checkout(tmpDir, "main");

    const res = await runCli(["sync"]);

    expect(res.exitCode).toBe(0);
    expect(res.out).toContain("Finished the interrupted restack");
    expect(res.out).toContain("main isn't in a stack, so there's no sync of its own to run.");
    expect(res.out).not.toContain("Git Stack Sync");
    expect(await isAncestor("pr1", "pr2")).toBe(true);
    expect((await savedState())?.finished_at).toBeTruthy();
  });
});
