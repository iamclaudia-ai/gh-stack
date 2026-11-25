// #159: `checkout` takes a branch name, and an argument it can't use exits 1,
// never 0 (an agent reads exit 0 as a switch). #158: `up` at a fork and `top`
// with several tips can't be answered by --yes, so they stop and name the
// branches and `gh-stack checkout <branch>`, instead of saying to pass --yes.
import { describe, expect, test } from "bun:test";
import {
  checkout,
  createBranch,
  createLinearStack,
  makeCommit,
  readMetadata,
  writeMetadata,
} from "./helpers.ts";
import { currentBranch, runCli, tmpDir, useResumeRunRepos } from "./resume-run-helpers.ts";

useResumeRunRepos();

/**
 * test-stack: main → pr1 → pr2 → pr3, plus `side`, a second child of `forkAt`
 * (pr1 by default), and a stack `lone` with one branch on main. On pr1.
 */
async function forkedStack(forkAt = "pr1"): Promise<void> {
  await createLinearStack(tmpDir);
  await createBranch(tmpDir, "side", forkAt);
  await makeCommit(tmpDir, "side.txt", "side\n", "side: add file");
  await createBranch(tmpDir, "lone", "main");
  await makeCommit(tmpDir, "lone.txt", "lone\n", "lone: add file");
  const meta = await readMetadata(tmpDir);
  meta.stacks["test-stack"]!.branches.side = { parent: forkAt, pr: 4, description: "Side" };
  meta.stacks.lone = {
    description: "",
    last_branch: "lone",
    branches: { lone: { parent: "main" } },
  };
  await writeMetadata(tmpDir, meta);
  await checkout(tmpDir, "pr1");
}

describe("checkout takes a branch name; an argument it can't use exits 1 (#159)", () => {
  test("checkout <branch> --yes switches to it", async () => {
    await forkedStack();

    const res = await runCli(["checkout", "pr3", "--yes"]);

    expect(res.exitCode).toBe(0);
    expect(await currentBranch()).toBe("pr3");
    expect((await readMetadata(tmpDir)).stacks["test-stack"]!.last_branch).toBe("pr3");
  });

  test("a branch of another stack switches to that stack too", async () => {
    await forkedStack();

    const res = await runCli(["checkout", "lone", "--yes"]);

    expect(res.exitCode).toBe(0);
    expect(await currentBranch()).toBe("lone");
    expect((await readMetadata(tmpDir)).current_stack).toBe("lone");
  });

  test("a position still works", async () => {
    await forkedStack();

    const res = await runCli(["checkout", "2", "--yes"]);

    expect(res.exitCode).toBe(0);
    expect(await currentBranch()).toBe("pr2");
  });

  test("a name no stack holds exits 1 and points at git checkout", async () => {
    await forkedStack();

    for (const name of ["nosuch", "main"]) {
      const res = await runCli(["checkout", name, "--yes"]);
      expect(res.exitCode).toBe(1);
      expect(res.out).toContain(`${name} isn't a branch of any stack`);
      expect(res.out).toContain(`git checkout ${name}`);
      expect(await currentBranch()).toBe("pr1");
    }
  });

  test("an unknown option, a second argument, or an argument with --stack exits 1", async () => {
    await forkedStack();

    const cases: [string[], string][] = [
      [["checkout", "--bogus", "--yes"], "Unknown option --bogus"],
      [["checkout", "pr2", "pr3", "--yes"], "Unexpected argument pr3"],
      [["checkout", "--stack", "lone", "--yes"], "Unexpected argument lone"],
    ];
    for (const [args, message] of cases) {
      const res = await runCli(args);
      expect(res.exitCode).toBe(1);
      expect(res.out).toContain(message);
      expect(res.out).toContain("checkout takes a stack position");
      expect(await currentBranch()).toBe("pr1");
    }
  });

  test("the pickers exit 1 under --yes instead of a 'Cancelled' exit 0", async () => {
    await forkedStack();

    const branch = await runCli(["checkout", "--yes"]);
    expect(branch.exitCode).toBe(1);
    expect(branch.out).toContain("Switch to branch: --yes can't choose for you.");
    expect(branch.out).toContain("gh-stack checkout <number|branch>");

    const stack = await runCli(["checkout", "--stack", "--yes"]);
    expect(stack.exitCode).toBe(1);
    expect(stack.out).toContain("Switch to stack: --yes can't choose for you.");

    const del = await runCli(["delete", "--yes"]);
    expect(del.exitCode).toBe(1);
    expect(del.out).toContain("--yes can't choose for you. Name the branch as an argument.");
    expect(Object.keys((await readMetadata(tmpDir)).stacks["test-stack"]!.branches)).toHaveLength(
      4,
    );
    expect(await currentBranch()).toBe("pr1");
  });
});

describe("up and top at a fork name the branches instead of saying to pass --yes (#158)", () => {
  test("up --yes at a fork exits 1, naming the children and checkout", async () => {
    await forkedStack();

    const res = await runCli(["up", "--yes"]);

    expect(res.exitCode).toBe(1);
    expect(res.out).toContain(
      "Several branches sit on pr1: pr2, side. Go to one with gh-stack checkout <branch>.",
    );
    expect(res.out).not.toContain("Pass --yes");
    // --yes stops before any prompt: in a person's terminal one would appear.
    expect(res.out).not.toContain("refusing to prompt");
    expect(await currentBranch()).toBe("pr1");
  });

  test("up with nobody to answer gives the same hint, not 'Pass --yes'", async () => {
    await forkedStack();

    const res = await runCli(["up"], {});

    expect(res.exitCode).toBe(1);
    expect(res.out).toContain("refusing to prompt");
    expect(res.out).toContain(
      "--yes can't choose a branch. Several branches sit on pr1: pr2, side. Go to one with gh-stack checkout <branch>.",
    );
    expect(res.out).not.toContain("Pass --yes");
  });

  test("up 2 --yes names the fork it reached, not the branch it started on", async () => {
    await forkedStack("pr2");

    const res = await runCli(["up", "2", "--yes"]);

    expect(res.exitCode).toBe(1);
    expect(res.out).toContain("Several branches sit on pr2: pr3, side.");
    expect(await currentBranch()).toBe("pr1");
  });

  test("top --yes with several tips exits 1, naming them", async () => {
    await forkedStack();

    const res = await runCli(["top", "--yes"]);

    expect(res.exitCode).toBe(1);
    expect(res.out).toContain(
      "The stack has several tips: pr3, side. Go to one with gh-stack checkout <branch>.",
    );
    expect(res.out).not.toContain("refusing to prompt");
    expect(await currentBranch()).toBe("pr1");
  });

  test("the named branch is one checkout away", async () => {
    await forkedStack();

    const res = await runCli(["checkout", "side", "--yes"]);

    expect(res.exitCode).toBe(0);
    expect(await currentBranch()).toBe("side");
  });
});
