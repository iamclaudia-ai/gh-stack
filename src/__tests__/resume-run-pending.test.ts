// #29: a bare restack/sync resumes a pending run instead of starting a different one, and a
// branch is never pushed onto a parent whose push didn't land.
import { describe, expect, test } from "bun:test";
import { $ } from "bun";
import {
  addConflictingMainCommit,
  checkout,
  createLinearStack,
  makeCommit,
  pushAllBranches,
} from "./helpers.ts";
import {
  addRemote,
  isAncestor,
  rejectRef,
  remoteSha,
  runCli,
  savedState,
  setPreReceive,
  sha,
  stackNeedingRestack,
  syncStoppedOnConflictThenContinued,
  tmpDir,
  useResumeRunRepos,
} from "./resume-run-helpers.ts";

useResumeRunRepos();

describe("a bare restack/sync with an interrupted run pending (#29)", () => {
  test("bare restack under GH_STACK_YES resumes the interrupted sync, not a fresh restack", async () => {
    await syncStoppedOnConflictThenContinued();
    const pr2Before = await sha("pr2");

    const res = await runCli(["restack"]);

    expect(res.exitCode).toBe(0);
    expect(res.out).toContain(
      "An interrupted sync was detected (stopped at pr1: rebasing onto origin/main)",
    );
    expect(res.out).toContain("Resuming the interrupted sync");
    // A fresh restack from pr1 would skip it as the base branch: the finished
    // run already covered it, so none runs (#82).
    expect(res.out).not.toContain("Skipping base branch");
    expect(res.out).toContain("That run covered the restack from pr1 too.");
    expect(await sha("pr2")).not.toBe(pr2Before);
    for (const b of ["pr1", "pr2", "pr3"]) {
      expect(await remoteSha(b)).toBe(await sha(b));
    }
    expect(await isAncestor("origin/main", "pr1")).toBe(true);
    expect(await isAncestor("pr1", "pr2")).toBe(true);
    expect(await isAncestor("pr2", "pr3")).toBe(true);
    expect((await savedState())?.finished_at).toBeTruthy();
  });

  test("a bare sync resumes it too", async () => {
    await syncStoppedOnConflictThenContinued();

    const res = await runCli(["sync"]);

    expect(res.exitCode).toBe(0);
    expect(res.out).toContain("Resuming the interrupted sync");
    for (const b of ["pr1", "pr2", "pr3"]) {
      expect(await remoteSha(b)).toBe(await sha(b));
    }
  });

  test("without --yes and no TTY it asks (and so exits) instead of starting fresh", async () => {
    await syncStoppedOnConflictThenContinued();
    const pr2Before = await sha("pr2");

    const res = await runCli(["restack"], {});

    expect(res.exitCode).toBe(1);
    expect(res.out).toContain("refusing to prompt");
    expect(res.out).toContain("An interrupted sync was detected");
    expect(await sha("pr2")).toBe(pr2Before);
    expect((await savedState())?.finished_at).toBeNull();
  });

  test("--fresh discards the interrupted run and restacks from the current branch", async () => {
    await syncStoppedOnConflictThenContinued();

    const res = await runCli(["restack", "--fresh"]);

    expect(res.exitCode).toBe(0);
    expect(res.out).toContain("--fresh: discarding the interrupted sync");
    expect(res.out).toContain("Skipping base branch");
    const state = await savedState();
    expect(state?.command).toBe("restack");
    expect(state?.finished_at).toBeTruthy();
  });

  test("while the conflict is unresolved, a bare restack names the resume path", async () => {
    await createLinearStack(tmpDir, { conflicting: true });
    await addRemote();
    await pushAllBranches(tmpDir);
    await addConflictingMainCommit(tmpDir);
    await $`git -C ${tmpDir} push -q origin main`.quiet();
    await checkout(tmpDir, "pr1");
    expect((await runCli(["sync"])).exitCode).toBe(2);

    const res = await runCli(["restack"]);

    expect(res.exitCode).toBe(1);
    expect(res.out).toContain(
      "An interrupted sync stopped on a conflict rebasing pr1 onto origin/main",
    );
    expect(res.out).toContain("gh-stack restack --resume");
  });

  async function syncStoppedOnConflictThenAborted(): Promise<void> {
    await createLinearStack(tmpDir, { conflicting: true });
    await addRemote();
    await pushAllBranches(tmpDir);
    await addConflictingMainCommit(tmpDir);
    await $`git -C ${tmpDir} push -q origin main`.quiet();
    await checkout(tmpDir, "pr1");
    expect((await runCli(["sync"])).exitCode).toBe(2);
    await $`git -C ${tmpDir} rebase --abort`.quiet();
  }

  test("after git rebase --abort, --resume runs that rebase again; the run is kept", async () => {
    await syncStoppedOnConflictThenAborted();

    const resume = await runCli(["restack", "--resume"]);
    expect(resume.exitCode).toBe(2); // the same conflict, met again
    expect(resume.out).toContain("didn't happen (interrupted before it started, or aborted)");
    const state = await savedState();
    expect(state?.finished_at).toBeNull();
    expect(state?.rebase?.branch).toBe("pr1");
  });

  test("after git rebase --abort, a bare restack resumes too; only --fresh discards", async () => {
    await syncStoppedOnConflictThenAborted();

    const res = await runCli(["restack"]);
    expect(res.exitCode).toBe(2);
    expect(res.out).toContain("Resuming the interrupted sync");
    await $`git -C ${tmpDir} rebase --abort`.quiet();

    const fresh = await runCli(["restack", "--fresh"]);
    expect(fresh.exitCode).toBe(0);
    expect(fresh.out).toContain("--fresh: discarding the interrupted sync");
    expect((await savedState())?.command).toBe("restack");
  });

  test("an abort keeps earlier branches' failed and held pushes; nothing is lost", async () => {
    // pr1's push is rejected (pr2 is held), then pr3's rebase conflicts.
    await createLinearStack(tmpDir);
    await addRemote();
    await pushAllBranches(tmpDir);
    await checkout(tmpDir, "pr1");
    await makeCommit(tmpDir, "pr3.txt", "from pr1\n", "pr1: conflicting pr3.txt");
    await setPreReceive(rejectRef("pr1"));
    expect((await runCli(["restack"])).exitCode).toBe(2);
    await $`git -C ${tmpDir} rebase --abort`.quiet();

    const again = await runCli(["restack", "--resume"]);
    expect(again.exitCode).toBe(2);
    const actions = (await savedState())!.log.map((e) => `${e.action} ${e.branch}`);
    expect(actions).toContain("push-failed pr1");
    expect(actions).toContain("push-held pr2");

    // Resolve it and let origin accept pushes again: everything lands.
    await setPreReceive(null);
    await Bun.write(`${tmpDir}/pr3.txt`, "resolved\n");
    await $`git -C ${tmpDir} add pr3.txt`.quiet();
    await $`git -C ${tmpDir} rebase --continue`.env({ ...process.env, GIT_EDITOR: "true" }).quiet();
    const done = await runCli(["restack", "--resume"]);
    expect(done.exitCode).toBe(0);
    for (const b of ["pr1", "pr2", "pr3"]) expect(await remoteSha(b)).toBe(await sha(b));
  });

  test("undo discards the run it rolled back, so nothing offers to resume it", async () => {
    await syncStoppedOnConflictThenContinued();

    const res = await runCli(["undo"]);

    expect(res.exitCode).toBe(0);
    expect(res.out).toContain("Discarded the interrupted sync's saved state");
    expect(await savedState()).toBeNull();
  });

  test("merge refuses while a run is pending", async () => {
    await syncStoppedOnConflictThenContinued();

    const res = await runCli(["merge"]);

    expect(res.exitCode).toBe(1);
    expect(res.out).toContain("An interrupted sync of stack test-stack is pending");
    expect(res.out).toContain("gh-stack restack --resume");
    expect(res.out).toContain("gh-stack restack --fresh");
    expect(res.out).toContain("restacks test-stack from the current branch");
  });

  test("a refused --fresh leaves the interrupted run intact (preconditions come first)", async () => {
    await syncStoppedOnConflictThenContinued();
    const path = `${tmpDir}/.git/.gh-stack/restack-state.json`;
    const before = await Bun.file(path).text();
    await Bun.write(`${tmpDir}/README.md`, "uncommitted\n"); // dirty tree

    for (const cmd of ["restack", "sync"]) {
      const res = await runCli([cmd, "--fresh"]);
      expect(res.exitCode).toBe(1);
      expect(res.out).toContain("Working tree is not clean");
      expect(res.out).not.toContain("discarding");
      expect(await Bun.file(path).text()).toBe(before);
    }
  });
});

describe("a failed parent push holds its children back (#29)", () => {
  test("the base branch's push is rejected: pr2/pr3 are rebased but not pushed; --resume finishes", async () => {
    await stackNeedingRestack();
    const before = { pr2: await remoteSha("pr2"), pr3: await remoteSha("pr3") };
    await setPreReceive(rejectRef("pr1"));

    const res = await runCli(["restack"]);

    expect(res.exitCode).toBe(1);
    expect(res.out).toContain("Push of pr1 failed");
    expect(res.out).toContain("Not pushing pr2: its parent pr1 isn't on origin");
    // Rebased locally, untouched on origin.
    expect(await isAncestor("pr1", "pr2")).toBe(true);
    expect(await remoteSha("pr2")).toBe(before.pr2);
    expect(await remoteSha("pr3")).toBe(before.pr3);
    const state = await savedState();
    expect(state?.finished_at).toBeNull();
    expect(state?.log.map((e) => `${e.action} ${e.branch}`)).toEqual([
      "push-failed pr1",
      "rebased pr2",
      "push-held pr2",
      "rebased pr3",
      "push-held pr3",
    ]);

    await setPreReceive(null);
    const resumed = await runCli(["restack", "--resume"]);

    expect(resumed.exitCode).toBe(0);
    for (const b of ["pr1", "pr2", "pr3"]) {
      expect(await remoteSha(b)).toBe(await sha(b));
    }
    expect((await savedState())?.finished_at).toBeTruthy();
  });

  test("a rebased child's push is rejected: its own child is held", async () => {
    await stackNeedingRestack();
    const pr3Before = await remoteSha("pr3");
    await setPreReceive(rejectRef("pr2"));

    const res = await runCli(["restack"]);

    expect(res.exitCode).toBe(1);
    expect(await remoteSha("pr1")).toBe(await sha("pr1"));
    expect(res.out).toContain("Not pushing pr3: its parent pr2 isn't on origin");
    expect(await remoteSha("pr3")).toBe(pr3Before);
  });
});
