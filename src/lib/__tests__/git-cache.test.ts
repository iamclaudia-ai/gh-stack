// The per-run cache of git answers (#108). Raw `git` calls here stand in for
// changes the cache can't see, so a test can tell a cached answer from a fresh
// one, and check that each write through runGit drops exactly the answers it
// can change.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { $ } from "bun";
import { readdir } from "node:fs/promises";
import * as path from "node:path";
import * as git from "../git.ts";
import { allBranchMemberships, getBranchMembership } from "../branch-config.ts";
import { cleanup, createTempRepo, makeCommit } from "../../__tests__/helpers.ts";

let tmpDir: string;
let originalCwd: string;

beforeEach(async () => {
  tmpDir = await createTempRepo();
  originalCwd = process.cwd();
  process.chdir(tmpDir);
});

afterEach(async () => {
  git.setGitCache(false);
  process.chdir(originalCwd);
  await $`git -C ${tmpDir} worktree remove --force ${tmpDir}-wt`.quiet().nothrow();
  await cleanup(`${tmpDir}-wt`);
  await cleanup(tmpDir);
});

/** One answer of each cached kind. */
interface Answers {
  refs: string;
  branches: boolean;
  head: string;
  config: string | undefined;
  worktrees: number;
}
type Kind = keyof Answers;
const KINDS: Kind[] = ["refs", "branches", "head", "config", "worktrees"];

async function ask(): Promise<Answers> {
  return {
    refs: await git.revParse("side"),
    branches: await git.localBranchExists("made"),
    head: await git.currentBranch(),
    config: (await getBranchMembership("main")).stack,
    worktrees: (await git.listWorktrees()).length,
  };
}

/** The same answers straight from git, leaving the cache alone. */
async function truthNow(): Promise<Answers> {
  const out = (cmd: ReturnType<typeof $>) => cmd.quiet().nothrow().text();
  const config = (await out($`git config branch.main.ghstack-stack`)).trim();
  return {
    refs: (await out($`git rev-parse side`)).trim(),
    branches:
      (await $`git show-ref --verify --quiet refs/heads/made`.quiet().nothrow()).exitCode === 0,
    head: (await out($`git rev-parse --abbrev-ref HEAD`)).trim(),
    config: config || undefined,
    worktrees: (await out($`git worktree list --porcelain`)).match(/^worktree /gm)?.length ?? 0,
  };
}

/**
 * Cache an answer of every kind, then change all of them behind the cache's
 * back. Returns the cached (now stale) answers and the true ones.
 */
async function staleEverything(): Promise<{ stale: Answers; truth: Answers }> {
  await $`git branch side`.quiet();
  git.setGitCache(true);
  const stale = await ask();
  expect(await truthNow()).toEqual(stale); // both readers agree
  await $`git checkout -q side`.quiet();
  await makeCommit(tmpDir, "side.txt", "side\n", "side");
  await $`git branch made`.quiet();
  await $`git config branch.main.ghstack-stack s`.quiet();
  await $`git worktree add -q --detach ${tmpDir}-wt`.quiet();
  const truth = await truthNow();
  for (const kind of KINDS) expect(truth[kind]).not.toEqual(stale[kind]);
  // Nothing has invalidated anything yet.
  expect(await ask()).toEqual(stale);
  return { stale, truth };
}

describe("git answer cache", () => {
  test("is off by default: every call asks git", async () => {
    const before = await git.revParse("main");
    await makeCommit(tmpDir, "a.txt", "a\n", "a");
    expect(await git.revParse("main")).not.toBe(before);
  });

  test("on, it answers a repeat from the cache until something clears it", async () => {
    const { stale, truth } = await staleEverything();
    expect(await ask()).toEqual(stale);
    git.clearGitCache();
    expect(await ask()).toEqual(truth);
  });

  // Each write drops the kinds it can change and keeps the rest.
  const writes: { name: string; args: string[]; changes: Kind[] }[] = [
    { name: "a config write", args: ["config", "gh-stack.probe", "1"], changes: ["config"] },
    { name: "a tag", args: ["tag", "probe-tag"], changes: ["refs"] },
    { name: "a commit", args: ["commit", "--allow-empty", "-q", "-m", "e"], changes: ["refs"] },
    { name: "an index refresh", args: ["update-index", "--refresh"], changes: [] },
    {
      name: "update-ref",
      args: ["update-ref", "refs/heads/made-too", "HEAD"],
      changes: ["refs", "branches"],
    },
    {
      name: "a checkout",
      args: ["checkout", "-q", "side"],
      changes: ["refs", "branches", "head", "worktrees"],
    },
    { name: "an unknown command (branch)", args: ["branch", "other"], changes: KINDS },
  ];
  for (const { name, args, changes } of writes) {
    test(`${name} drops ${changes.join(", ") || "nothing"}`, async () => {
      const { stale } = await staleEverything();
      await git.runGitOrThrow(args);
      const now = await ask();
      const truth = await truthNow(); // the write itself may have moved something (a commit)
      for (const kind of KINDS) {
        expect([kind, now[kind]]).toEqual([
          kind,
          changes.includes(kind) ? truth[kind] : stale[kind],
        ]);
      }
    });
  }

  test("a write that fails still drops what it could have changed", async () => {
    const { truth } = await staleEverything();
    const r = await git.runGit(["checkout", "no-such-branch"]);
    expect(r.exitCode).not.toBe(0);
    expect(await git.currentBranch()).toBe(truth.head);
  });

  test("a push reported with noteGitWrite drops refs", async () => {
    const { stale, truth } = await staleEverything();
    git.noteGitWrite(["push"]);
    const now = await ask();
    expect(now.refs).toBe(truth.refs);
    expect(now.head).toBe(stale.head);
  });

  test("a failed lookup isn't cached", async () => {
    git.setGitCache(true);
    await expect(git.revParse("later")).rejects.toThrow();
    await $`git branch later`.quiet();
    expect(await git.revParse("later")).toBe(await git.revParse("main"));
  });

  test("callers get their own copies of worktrees and memberships", async () => {
    git.setGitCache(true);
    await $`git config branch.main.ghstack-stack s`.quiet();
    const wts = await git.listWorktrees();
    wts[0]!.branch = "changed";
    expect((await git.listWorktrees())[0]!.branch).toBe("main");
    const all = await allBranchMemberships();
    all.get("main")!.stack = "changed";
    expect((await getBranchMembership("main")).stack).toBe("s");
  });
});

// Every write must reach the cache: through runGit, or reported with
// noteGitWrite (git.ts's own push). A raw `$\`git <write>\`` anywhere else
// would leave stale answers behind it.
describe("raw git writes", () => {
  const WRITE =
    /\$`git (?:-C \S+ )?(checkout|switch|rebase|reset|merge|pull|fetch|push|commit|cherry-pick|revert|update-ref|branch|tag (?!-l)|config (?!--get)|worktree (?!list)|stash|am )/;

  test("go through runGit outside git.ts", async () => {
    const root = path.resolve(import.meta.dir, "../..");
    const offenders: string[] = [];
    for (const dir of ["commands", "lib"]) {
      for (const file of await readdir(path.join(root, dir))) {
        if (!file.endsWith(".ts") || file === "git.ts") continue;
        const lines = (await Bun.file(path.join(root, dir, file)).text()).split("\n");
        lines.forEach((line, i) => {
          if (WRITE.test(line)) offenders.push(`${dir}/${file}:${i + 1}: ${line.trim()}`);
        });
      }
    }
    expect(offenders).toEqual([]);
  });
});
