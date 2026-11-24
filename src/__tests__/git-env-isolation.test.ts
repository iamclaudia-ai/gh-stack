// Regression: tests must never touch the enclosing git repository.
//
// The pre-push hook runs `bun test`, and git exports GIT_DIR to hooks (an
// absolute path in a linked worktree). Before this was guarded, the helpers'
// `git branch -M main`, `git config user.*` and `git init --bare` ran against
// the real repo: the pushed branch was renamed over local main, and core.bare
// was set to true. Two layers guard it: the hook clears the variables, and the
// bunfig preload scrubs them for the suite (including bare Bun.spawn calls).
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { $ } from "bun";

const repoRoot = path.resolve(import.meta.dir, "../..");

async function snapshot(gitDir: string) {
  const git = (args: string[]) => $`git --git-dir=${gitDir} ${args}`.nothrow().text();
  return {
    head: (await git(["symbolic-ref", "HEAD"])).trim(),
    refs: (await git(["for-each-ref", "--format=%(refname) %(objectname)"])).trim(),
    config: await fs.readFile(path.join(gitDir, "config"), "utf8"),
  };
}

// #106 helpers: one pre-push stdin line, and the hook run with a failing stub `bun`.
const zero = "0".repeat(40);
const a = "a".repeat(40);
const b = "b".repeat(40);
const line = (localRef: string, localSha: string, remoteRef: string, remoteSha: string) =>
  `${localRef} ${localSha} ${remoteRef} ${remoteSha}\n`;

async function runHook(stdin: string) {
  const stubDir = await fs.mkdtemp(path.join(await fs.realpath("/tmp"), "gh-stack-stub-"));
  try {
    await Bun.write(path.join(stubDir, "bun"), '#!/bin/sh\necho "STUB CHECKS RAN"\nexit 1\n');
    await fs.chmod(path.join(stubDir, "bun"), 0o755);
    const proc = Bun.spawn(["sh", "-e", path.join(repoRoot, ".husky/pre-push")], {
      cwd: repoRoot,
      env: { ...process.env, PATH: `${stubDir}:${process.env.PATH}` },
      stdin: new TextEncoder().encode(stdin),
      stdout: "pipe",
      stderr: "pipe",
    });
    const output =
      (await new Response(proc.stdout).text()) + (await new Response(proc.stderr).text());
    return { exitCode: await proc.exited, ran: output.includes("STUB CHECKS RAN"), output };
  } finally {
    await fs.rm(stubDir, { recursive: true, force: true });
  }
}

describe("git env isolation", () => {
  test("GIT_DIR from a hook does not leak into the test helpers", async () => {
    const victim = await fs.mkdtemp(path.join(await fs.realpath("/tmp"), "gh-stack-victim-"));
    try {
      await $`git init -q -b keepme ${victim}`.quiet();
      await $`git -C ${victim} -c user.email=v@v -c user.name=V commit -q --allow-empty -m victim`.quiet();
      const gitDir = path.join(victim, ".git");
      const before = await snapshot(gitDir);

      const proc = Bun.spawn(["bun", "test", "./src/__tests__/fixtures/git-env.fixture.ts"], {
        cwd: repoRoot,
        env: { ...process.env, GIT_DIR: gitDir, GIT_INDEX_FILE: path.join(gitDir, "index") },
        stdout: "pipe",
        stderr: "pipe",
      });
      const output =
        (await new Response(proc.stderr).text()) + (await new Response(proc.stdout).text());
      const exitCode = await proc.exited;

      expect(await snapshot(gitDir)).toEqual(before);
      expect(output).toContain("1 pass");
      expect(exitCode).toBe(0);
    } finally {
      await fs.rm(victim, { recursive: true, force: true });
    }
  }, 60_000);

  // A push made by `GH_STACK_YES=1 gh-stack submit` runs the hook with
  // GH_STACK_YES set, and tests of interactive behavior failed under it, so
  // git refused the push.
  test("GH_STACK_* variables from a hook do not reach the tests", async () => {
    const proc = Bun.spawn(["bun", "test", "./src/__tests__/fixtures/gh-stack-env.fixture.ts"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        GH_STACK_YES: "1",
        GH_STACK_PLAIN: "1",
        GH_STACK_NO_COLOR: "1",
        GH_STACK_DRAFT: "1",
        GH_STACK_NO_PUSH: "1",
        GH_STACK_TEST_RETRY_DELAY_MS: "5000",
        GH_STACK_TEST_HELPER_TIMEOUT_MS: "1",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const output =
      (await new Response(proc.stderr).text()) + (await new Response(proc.stdout).text());

    expect(output).toContain("1 pass");
    expect(await proc.exited).toBe(0);
  }, 60_000);

  // gh-stack shows only the end of a failed push's output, and Bun doesn't
  // repeat its failures at the end, so the hook lists them last.
  test("pre-push lists the failing tests at the end of its output", async () => {
    const stubDir = await fs.mkdtemp(path.join(await fs.realpath("/tmp"), "gh-stack-stub-"));
    try {
      await Bun.write(
        path.join(stubDir, "bun"),
        [
          "#!/bin/sh",
          'echo "(pass) suite > fine"',
          'echo "(fail) suite > first broken test"',
          'echo "lots of other output"',
          'echo "(fail) other > second broken test"',
          'echo " 1 pass"',
          'echo " 2 fail"',
          "exit 1",
          "",
        ].join("\n"),
      );
      await fs.chmod(path.join(stubDir, "bun"), 0o755);

      const proc = Bun.spawn(["sh", "-e", path.join(repoRoot, ".husky/pre-push")], {
        cwd: repoRoot,
        env: { ...process.env, PATH: `${stubDir}:${process.env.PATH}` },
        stdout: "pipe",
        stderr: "pipe",
      });
      const output = await new Response(proc.stdout).text();

      expect(await proc.exited).toBe(1);
      expect(output.trimEnd()).toEndWith(
        [
          "Failing tests:",
          "(fail) suite > first broken test",
          "(fail) other > second broken test",
        ].join("\n"),
      );
    } finally {
      await fs.rm(stubDir, { recursive: true, force: true });
    }
  });

  // The hook itself, run the way husky runs it (`sh -e`), with a stub `bun`
  // that reports what it inherited and fails.
  test("pre-push clears GIT_DIR and prints a failing check's output", async () => {
    const stubDir = await fs.mkdtemp(path.join(await fs.realpath("/tmp"), "gh-stack-stub-"));
    try {
      await Bun.write(
        path.join(stubDir, "bun"),
        '#!/bin/sh\necho "stub saw GIT_DIR=${GIT_DIR:-unset} GIT_INDEX_FILE=${GIT_INDEX_FILE:-unset}"\nexit 1\n',
      );
      await fs.chmod(path.join(stubDir, "bun"), 0o755);

      const proc = Bun.spawn(["sh", "-e", path.join(repoRoot, ".husky/pre-push")], {
        cwd: repoRoot,
        env: {
          ...process.env,
          PATH: `${stubDir}:${process.env.PATH}`,
          GIT_DIR: "/nonexistent/leaked-git-dir",
          GIT_INDEX_FILE: "/nonexistent/leaked-index",
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const output =
        (await new Response(proc.stdout).text()) + (await new Response(proc.stderr).text());

      expect(await proc.exited).toBe(1);
      expect(output).toContain("stub saw GIT_DIR=unset GIT_INDEX_FILE=unset");
    } finally {
      await fs.rm(stubDir, { recursive: true, force: true });
    }
  });

  // #106: a push that only deletes branches or pushes tags carries no new code,
  // so the hook skips the checks. Git sends one line per ref on stdin:
  // `<local ref> <local sha> <remote ref> <remote sha>`. The stub `bun` fails
  // loudly, so a run of the checks shows up as exit 1 with its marker.
  describe("pre-push skips pushes with no branch update", () => {
    test.each([
      ["a branch deletion", line("(delete)", zero, "refs/heads/old", a)],
      [
        "several branch deletions",
        line("(delete)", zero, "refs/heads/one", a) + line("(delete)", zero, "refs/heads/two", b),
      ],
      ["a deletion in a SHA-256 repo", line("(delete)", "0".repeat(64), "refs/heads/old", a)],
      ["a new tag", line("refs/tags/v1.2.3", a, "refs/tags/v1.2.3", zero)],
      ["a tag pushed from HEAD", line("HEAD", a, "refs/tags/v1.2.3", zero)],
      [
        "tags mixed with deletions",
        line("refs/tags/v1", a, "refs/tags/v1", zero) +
          line("(delete)", zero, "refs/tags/v0", b) +
          line("(delete)", zero, "refs/heads/old", b),
      ],
    ])("skips the checks for %s", async (_name, stdin) => {
      const r = await runHook(stdin);
      expect(r.ran).toBe(false);
      expect(r.output).toContain("skipping the checks");
      expect(r.exitCode).toBe(0);
    });

    test.each([
      ["a branch update", line("refs/heads/feat", b, "refs/heads/feat", a)],
      // remote sha all zeros: only the local sha marks a deletion.
      ["a new branch", line("refs/heads/feat", a, "refs/heads/feat", zero)],
      // a real sha can start with zeros: only an all-zero sha is a deletion.
      ["a zero-prefixed sha", line("refs/heads/feat", "0".repeat(39) + "1", "refs/heads/feat", a)],
      [
        "a branch update pushed with a tag and a deletion",
        line("refs/tags/v1", a, "refs/tags/v1", zero) +
          line("(delete)", zero, "refs/heads/old", b) +
          line("refs/heads/main", b, "refs/heads/main", a),
      ],
      // Nothing to classify: run the checks rather than guess.
      ["empty input", ""],
    ])("runs the checks for %s", async (_name, stdin) => {
      const r = await runHook(stdin);
      expect(r.ran).toBe(true);
      expect(r.exitCode).toBe(1);
    });
  });
});

// #86: no test reaches the real gh. The preload puts a fake first on PATH, so
// a gh wrapper that swaps in the developer's account (and can fail under load
// with empty stderr) never runs, in-process or in a spawned CLI.
describe("gh isolation", () => {
  test("gh resolves to the preload's fake, which answers 'no GitHub remote'", async () => {
    const resolved = (await $`which gh`.text()).trim();
    expect(path.basename(path.dirname(resolved))).toStartWith("gh-stack-test-gh-");

    const r = await $`gh pr view 1 --json state`.nothrow().quiet();
    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain("none of the git remotes configured for this repository");
  });

  test("a bare Bun.spawn finds the fake too", () => {
    const r = Bun.spawnSync(["gh", "api", "user"]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain("none of the git remotes configured for this repository");
  });
});
