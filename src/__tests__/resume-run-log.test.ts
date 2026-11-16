// #15: every restack/sync keeps a saved state with an action log until its last push, and
// `restack --resume` continues it (or reports that it finished). Also the #49 review fixes.
import { describe, expect, test } from "bun:test";
import { $ } from "bun";
import { checkout, createLinearStack, makeCommit, pushAllBranches } from "./helpers.ts";
import {
  addRemote,
  isAncestor,
  remoteDir,
  remoteSha,
  runCli,
  savedState,
  setPreReceive,
  sha,
  spawnCli,
  stackNeedingRestack,
  syncStoppedOnConflictThenContinued,
  tmpDir,
  useResumeRunRepos,
  writeState,
} from "./resume-run-helpers.ts";
import { RUN_STATE_VERSION } from "../types.ts";

useResumeRunRepos();

describe("the action log survives until the pushes are done (#15)", () => {
  test("killed during the push phase: --resume finishes the pushes, then reports the finished run", async () => {
    await stackNeedingRestack();
    const pidFile = `${tmpDir}/.git/test-cli.pid`;
    // Pushing pr3 kills gh-stack mid-push (like the host wrapper's SIGTERM in
    // #15), after every rebase is done, and rejects the push.
    await setPreReceive(`#!/bin/sh
while read old new ref; do
  if [ "$ref" = "refs/heads/pr3" ]; then
    i=0
    while [ ! -s "${pidFile}" ] && [ $i -lt 100 ]; do sleep 0.1; i=$((i+1)); done
    kill -TERM "$(cat "${pidFile}")"
    exit 1
  fi
done
exit 0
`);

    const proc = spawnCli(["restack"], { GH_STACK_YES: "1" });
    await Bun.write(pidFile, String(proc.pid));
    const code = await proc.exited;
    expect(code).not.toBe(0);
    // Let the orphaned `git push` finish (the hook rejects it).
    for (let i = 0; i < 50 && (await savedState())?.log.length === 0; i++) await Bun.sleep(100);

    const state = await savedState();
    expect(state).not.toBeNull();
    expect(state!.finished_at).toBeNull();
    expect(state!.chain[state!.current_index]).toBe("pr3");
    expect(await remoteSha("pr3")).not.toBe(await sha("pr3"));

    await setPreReceive(null);
    const resumed = await runCli(["restack", "--resume"]);

    expect(resumed.exitCode).toBe(0);
    expect(resumed.out).not.toContain("No saved state");
    expect(resumed.out).toContain("Done before the interruption:");
    expect(resumed.out).toContain("✓ rebased pr3 onto pr2");
    for (const b of ["pr1", "pr2", "pr3"]) {
      expect(await remoteSha(b)).toBe(await sha(b));
    }

    // Everything's done now: a second --resume reports it and succeeds.
    const again = await runCli(["restack", "--resume"]);
    expect(again.exitCode).toBe(0);
    expect(again.out).toContain("Nothing left to resume");
    expect(again.out).toContain("✓ pushed pr3");
  });

  test("--resume after a run that finished prints its log and exits 0", async () => {
    await stackNeedingRestack();
    expect((await runCli(["restack"])).exitCode).toBe(0);

    const res = await runCli(["restack", "--resume"]);

    expect(res.exitCode).toBe(0);
    expect(res.out).toContain("Nothing left to resume");
    expect(res.out).toContain("✓ rebased pr2 onto pr1");
    expect(res.out).toContain("✓ pushed pr2");
  });

  test("--resume with no saved state at all says so and how to recover", async () => {
    await createLinearStack(tmpDir);

    const res = await runCli(["restack", "--resume"]);

    expect(res.exitCode).toBe(1);
    expect(res.out).toContain("Nothing to resume: there's no saved run state");
    expect(res.out).toContain("gh-stack restack");
  });

  test("a resumed local-only run stays local-only (#47 regression guard)", async () => {
    await createLinearStack(tmpDir);
    await addRemote();
    await pushAllBranches(tmpDir);
    await checkout(tmpDir, "pr1");
    await makeCommit(tmpDir, "pr2.txt", "from pr1\n", "pr1: conflicting pr2.txt");
    expect((await runCli(["restack", "--no-push"])).exitCode).toBe(2);
    await Bun.write(`${tmpDir}/pr2.txt`, "resolved\n");
    await $`git -C ${tmpDir} add pr2.txt`.quiet();
    await $`git -C ${tmpDir} rebase --continue`.env({ ...process.env, GIT_EDITOR: "true" }).quiet();
    const pr2Remote = await remoteSha("pr2");

    const res = await runCli(["restack"]);

    expect(res.exitCode).toBe(0);
    expect(res.out).toContain("Resuming the interrupted restack");
    expect(await remoteSha("pr2")).toBe(pr2Remote);
  });
});

describe("review fixes (#49)", () => {
  test("--resume --dry-run writes nothing; the real resume still restacks pr2..pr3", async () => {
    await syncStoppedOnConflictThenContinued();
    const path = `${tmpDir}/.git/.gh-stack/restack-state.json`;
    const before = await Bun.file(path).text();

    const dry = await runCli(["restack", "--resume", "--dry-run"]);
    expect(dry.exitCode).toBe(0);
    expect(await Bun.file(path).text()).toBe(before);

    const res = await runCli(["restack", "--resume"]);
    expect(res.exitCode).toBe(0);
    expect(await isAncestor("pr1", "pr2")).toBe(true);
    expect(await isAncestor("pr2", "pr3")).toBe(true);
    for (const b of ["pr1", "pr2", "pr3"]) expect(await remoteSha(b)).toBe(await sha(b));
  });

  test("a stale remote-tracking ref can't wedge the run: in-sync is judged from origin itself", async () => {
    await stackNeedingRestack();
    expect((await runCli(["restack"])).exitCode).toBe(0);
    // Someone moves origin/pr2 back; this clone hasn't fetched, so its
    // tracking ref still matches local pr2. Judged by that ref, pr2 is "in
    // sync" and never pushed, while the hold check (reading origin) holds
    // pr3 on every resume: a loop with no way out.
    await $`git -C ${remoteDir} update-ref refs/heads/pr2 ${await sha("pr1~1")}`.quiet();
    await checkout(tmpDir, "pr2");

    // The remote guard reads origin's pr2, sees it's an ancestor of local pr2
    // (nothing new), and clears it: the push gets an explicit lease on that
    // exact sha, so it lands without a fetch. (On #49 alone the implicit lease
    // refused here and the hint said to fetch.)
    const resumed = await runCli(["restack"]);
    expect(resumed.exitCode).toBe(0);
    expect(resumed.out).toContain("Force-push pr2?");
    for (const b of ["pr2", "pr3"]) expect(await remoteSha(b)).toBe(await sha(b));
  });

  test("a lagging tracking ref with origin already current is in sync (#23)", async () => {
    await stackNeedingRestack();
    expect((await runCli(["restack"])).exitCode).toBe(0);
    await $`git -C ${tmpDir} update-ref refs/remotes/origin/pr3 ${await sha("pr3~1")}`.quiet();
    await checkout(tmpDir, "pr2");

    const res = await runCli(["restack"]);

    expect(res.exitCode).toBe(0);
    expect(res.out).not.toContain("Push Rebased Branch?");
    expect((await savedState())?.finished_at).toBeTruthy();
  });

  test("a declined rebase isn't pushed on resume: it and its children are restacked first", async () => {
    await stackNeedingRestack(); // pr1 has a new commit
    await checkout(tmpDir, "pr2");
    await makeCommit(tmpDir, "pr2-local.txt", "local\n", "pr2: unpushed work");
    // The run rebased nothing above pr1: pr2's rebase was declined.
    await writeState({
      current_index: 3,
      declined: ["pr2"],
      log: [
        { at: new Date().toISOString(), branch: "pr2", action: "rebase-declined", onto: "pr1" },
      ],
    });

    const res = await runCli(["restack", "--resume"]);

    expect(res.exitCode).toBe(0);
    expect(await isAncestor("pr1", "pr2")).toBe(true);
    expect(await isAncestor("pr2", "pr3")).toBe(true);
    expect(await isAncestor(await sha("pr1"), await remoteSha("pr2"))).toBe(true);
    expect((await savedState())?.declined).toEqual([]);
  });

  test("a --push override on --resume is kept by a later plain --resume", async () => {
    // pr1 gains files that conflict with both pr2 and pr3, so the run stops twice.
    await createLinearStack(tmpDir);
    await addRemote();
    await pushAllBranches(tmpDir);
    await checkout(tmpDir, "pr1");
    await Bun.write(`${tmpDir}/pr2.txt`, "from pr1\n");
    await makeCommit(tmpDir, "pr3.txt", "from pr1\n", "pr1: conflicting pr2.txt and pr3.txt");
    await $`git -C ${tmpDir} add pr2.txt`.quiet();
    await $`git -C ${tmpDir} commit -q --amend --no-edit`.quiet();
    const resolve = async (file: string) => {
      await Bun.write(`${tmpDir}/${file}`, "resolved\n");
      await $`git -C ${tmpDir} add ${file}`.quiet();
      await $`git -C ${tmpDir} rebase --continue`
        .env({ ...process.env, GIT_EDITOR: "true" })
        .quiet();
    };

    expect((await runCli(["restack", "--no-push"])).exitCode).toBe(2);
    await resolve("pr2.txt");
    expect((await runCli(["restack", "--resume", "--push"])).exitCode).toBe(2);
    expect((await savedState())?.push).toBe(true);
    await resolve("pr3.txt");

    const res = await runCli(["restack", "--resume"]);

    expect(res.exitCode).toBe(0);
    expect(await remoteSha("pr3")).toBe(await sha("pr3"));
  });

  test("killed after saving the rebase but before git started it: --resume runs it", async () => {
    await stackNeedingRestack();
    await writeState({
      rebase: {
        branch: "pr2",
        onto: "pr1",
        onto_sha: await sha("pr1"),
        pre_tip: await sha("pr2"),
        boundary: await sha("pr1~1"),
      },
    });

    const res = await runCli(["restack", "--resume"]);

    expect(res.exitCode).toBe(0);
    expect(await isAncestor("pr1", "pr2")).toBe(true);
    expect(await isAncestor("pr2", "pr3")).toBe(true);
    for (const b of ["pr1", "pr2", "pr3"]) expect(await remoteSha(b)).toBe(await sha(b));
  });

  test("a state file from an older gh-stack is refused, not upgraded; --fresh discards it", async () => {
    await stackNeedingRestack();
    await Bun.write(
      `${tmpDir}/.git/.gh-stack/restack-state.json`,
      JSON.stringify({
        current_index: 1,
        stack_name: "test-stack",
        chain: ["pr1", "pr2"],
        push: true,
      }),
    );

    const res = await runCli(["restack"]);
    expect(res.exitCode).toBe(1);
    expect(res.out).toContain("written by an older gh-stack");
    expect(res.out).toContain("gh-stack restack --fresh");

    const fresh = await runCli(["restack", "--fresh"]);
    expect(fresh.exitCode).toBe(0);
    expect((await savedState())?.version).toBe(RUN_STATE_VERSION);
  });
});
