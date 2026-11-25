// #126: a restack from mid-stack or the top also pushes the branches below it
// whose local tips origin doesn't have, parents first. Without them, every
// branch above is held back (#29), and `--resume`, which retries only the run's
// own chain, never gets past them.
import { describe, expect, test } from "bun:test";
import { $ } from "bun";
import { checkout, createLinearStack, makeCommit, pushAllBranches } from "./helpers.ts";
import {
  addRemote,
  rejectRef,
  remoteSha,
  runCli,
  savedState,
  setPreReceive,
  sha,
  stackNeedingRestack,
  tmpDir,
  useResumeRunRepos,
  writeState,
} from "./resume-run-helpers.ts";

useResumeRunRepos();

/** main → pr1 → pr2 → pr3 on origin; pr1 gains a commit, restacked locally only. */
async function restackedLocally(): Promise<void> {
  await stackNeedingRestack(); // on pr1, with a new commit
  const local = await runCli(["restack", "--no-push"]);
  expect(local.exitCode).toBe(0);
  for (const b of ["pr1", "pr2", "pr3"]) expect(await remoteSha(b)).not.toBe(await sha(b));
}

async function allOnOrigin(): Promise<void> {
  for (const b of ["pr1", "pr2", "pr3"]) expect(await remoteSha(b)).toBe(await sha(b));
}

describe("restack pushes the branches below the one it runs from (#126)", () => {
  test("restack --push from the top pushes the unpublished branches below it, parents first", async () => {
    await restackedLocally();
    await checkout(tmpDir, "pr3");

    const res = await runCli(["restack", "--push"]);

    expect(res.exitCode).toBe(0);
    expect(res.out).not.toContain("Not pushing");
    await allOnOrigin();
    const order = ["pr1", "pr2", "pr3"].map((b) => res.out.indexOf(`Pushed ${b}`));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // Nothing left pending for a later resume to stumble over.
    expect((await savedState())?.finished_at).toBeTruthy();
  });

  test("from mid-stack: the branch below is pushed, the rest of the chain restacks as usual", async () => {
    await restackedLocally();
    await checkout(tmpDir, "pr2");
    await makeCommit(tmpDir, "pr2-more.txt", "more\n", "more on pr2");

    const res = await runCli(["restack", "--push"]);

    expect(res.exitCode).toBe(0);
    await allOnOrigin();
    expect(
      (await $`git -C ${tmpDir} merge-base --is-ancestor pr2 pr3`.nothrow().quiet()).exitCode,
    ).toBe(0);
  });

  test("--resume retries a failed push below the start branch, then the branch it held", async () => {
    await restackedLocally();
    await checkout(tmpDir, "pr3");
    await setPreReceive(rejectRef("pr2"));

    const first = await runCli(["restack", "--push"]);

    expect(first.exitCode).toBe(1);
    expect(await remoteSha("pr1")).toBe(await sha("pr1"));
    expect(await remoteSha("pr2")).not.toBe(await sha("pr2"));
    expect(await remoteSha("pr3")).not.toBe(await sha("pr3"));
    expect(first.out).toContain("Not pushing pr3");

    await setPreReceive(null);
    const resumed = await runCli(["restack", "--resume"]);

    expect(resumed.exitCode).toBe(0);
    await allOnOrigin();
  });

  test("a pending run that held the top back finishes from the bottom (the issue's second report)", async () => {
    await restackedLocally();
    // An earlier restack --push from pr3 held it back on pr2 and stayed pending.
    await writeState({
      chain: ["pr3"],
      push_only: [],
      current_index: 1,
      push: true,
      log: [{ at: new Date().toISOString(), branch: "pr3", action: "push-held", detail: "pr2" }],
    });
    await checkout(tmpDir, "pr1");

    const res = await runCli(["restack", "--push"]);

    expect(res.exitCode).toBe(0);
    await allOnOrigin();
    // pr3's run didn't restack pr1's children, so the bare restack still runs.
    expect(res.out).toContain("Now the restack you ran, from pr1:");
    expect(res.out).not.toContain("covered the restack");
  });

  test("a dry run names the branches below it would push, and pushes nothing", async () => {
    await restackedLocally();
    await checkout(tmpDir, "pr3");
    const before = ["pr1", "pr2", "pr3"].map((b) => remoteSha(b));

    const res = await runCli(["restack", "--push", "--dry-run"]);

    expect(res.exitCode).toBe(0);
    expect(res.out).toContain("[DRY RUN] Would push pr1, pr2 first");
    expect(await Promise.all(["pr1", "pr2", "pr3"].map((b) => remoteSha(b)))).toEqual(
      await Promise.all(before),
    );
  });

  test("--no-push leaves the branches below alone", async () => {
    await restackedLocally();
    await checkout(tmpDir, "pr3");
    const before = await remoteSha("pr1");

    const res = await runCli(["restack", "--no-push"]);

    expect(res.exitCode).toBe(0);
    expect(res.out).not.toContain("Origin lags behind");
    expect(await remoteSha("pr1")).toBe(before);
  });

  test("a branch below that's behind origin isn't pushed backwards", async () => {
    await createLinearStack(tmpDir);
    await addRemote();
    await pushAllBranches(tmpDir);
    // Someone else's commit on origin's pr1, on top of the pr1 we have.
    await checkout(tmpDir, "pr1");
    await makeCommit(tmpDir, "theirs.txt", "theirs\n", "their commit on pr1");
    await $`git -C ${tmpDir} push -q origin pr1`.quiet();
    await $`git -C ${tmpDir} reset -q --hard HEAD~1`.quiet();
    const theirs = await remoteSha("pr1");
    await checkout(tmpDir, "pr3");
    await makeCommit(tmpDir, "pr3-more.txt", "more\n", "more on pr3");

    const res = await runCli(["restack", "--push"]);

    expect(res.exitCode).toBe(0);
    expect(await remoteSha("pr1")).toBe(theirs);
    expect(await remoteSha("pr3")).toBe(await sha("pr3"));
  });
});
