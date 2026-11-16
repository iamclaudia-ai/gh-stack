# gh-stack — Claude Code Instructions

## Project Overview

A Bun-compiled CLI tool for managing stacked PRs in Git repos that use squash-merge. Replaces 7+ bash scripts with a single `gh-stack` binary.

**Key docs:**
- `PLAN.md` — Full implementation plan, project structure, phased approach, key behaviors to preserve
- `DESIGN.md` — Spec, man page, design decisions, metadata schema
- `reference/` — Original shell scripts being ported (read-only reference)

## Quick Reference

```bash
bun install              # Install deps
bun run build            # Compile standalone binary → dist/gh-stack
bun run src/index.ts     # Run in dev mode
bun run test             # Run tests (8 files in parallel, ~1 min)
```

## Tech Stack

- **Bun** — Runtime, bundler, test runner
- **TypeScript** — Strict mode
- **@clack/prompts** — Interactive TUI (arrow keys, confirmations, spinners)
- **picocolors** — Terminal colors
- **git / gh** — Shell out for git operations and GitHub API

## Architecture

- `src/index.ts` — CLI entry point, subcommand router
- `src/commands/` — One file per subcommand (init, create, submit, log, restack, etc.)
- `src/lib/` — Shared modules (metadata, git, github, ui, safety, snapshot)
- `src/types.ts` — Metadata schema types
- `reference/` — Original bash scripts for behavior reference

## Conventions

- Use `Bun.spawn` / `Bun.spawnSync` for git/gh commands
- The CLI caches git lookups for the run (`currentBranch`, `revParse`, `localBranchExists`,
  `listWorktrees`, branch config, git dir; see "Per-run cache" in `src/lib/git.ts`, #108).
  Every git **write** must go through `runGit`/`runRebase` (or call `noteGitWrite` right
  after), or later lookups return stale answers. `git-cache.test.ts` fails on a raw
  `` $`git <write>` `` outside `git.ts`. A new git subcommand gets a case in `changedBy`.
- All user-facing output goes through `@clack/prompts` or `picocolors`
- Never modify metadata without reading it fresh first (avoid stale state)
- Metadata lives under `.git/.gh-stack/` (v3: per-stack files + git branch config; never committed). The old v2 `.git/gh-stack-metadata.json` monolith is migrated by `gh-stack doctor`. See `src/lib/metadata.ts`, `src/lib/paths.ts`, `src/lib/branch-config.ts`.
- All destructive operations (restack, merge, sync, remove) must take a snapshot first
- Reject rebase operations if working tree is dirty (force user to stash/commit)
- Never force-push main

## Building

```bash
bun run build   # bun build --compile + ad-hoc codesign on macOS
```

On macOS, `bun build --compile` appends the bundle to a linker-signed Mach-O,
leaving its ad-hoc signature invalid. macOS 27+ kills such binaries on launch
(`Killed: 9`, exit 137), so the build re-signs with `codesign --force --sign -`.
Always build via `bun run build`, never the raw `bun build` command.

The compiled binary is symlinked onto PATH (an absolute link, so re-run this
from the repo root after moving the checkout):
```bash
ln -sf "$(pwd)/dist/gh-stack" ~/.local/bin/gh-stack
```

## Testing

Test against real stacks in `~/Projects/beehiiv/swarm` during development.
For automated tests, create temp git repos with fabricated branch structures.

Run the suite with `bun run test`, not bare `bun test`: bare `bun test` runs the
files one at a time (~6 min), and bunfig.toml has no setting for `--parallel`.
8 workers is faster than one per core: the tests spawn ~32,000 git processes,
and with 16 workers they contend in the kernel. Run a single file with
`bun test <path>` as usual.

`bun run test` passes `--timings=test-timings.json`, so the parallel run starts
the slowest files first. Without it, Bun hands files out in discovery order, and
a 24s file that starts late stretches the run. Bun treats a file the timings
file doesn't list as average, so a new test file needs no entry; refresh it with
`bun run test:timings` (serial, ~5 min: parallel per-file times are inflated by
contention and skew the order) when files have been added or split. The refresh
merges, so a deleted or renamed file's entry stays until removed by hand.

With 8 workers, a file that runs alone for longer than an eighth of the serial
total (~40s of ~315s in Nov 2026) sets the minimum wall time; collapse-guard and
resume-run did (#108). Split such a file along its `describe` blocks, with the
shared fixtures in a `*-helpers.ts` beside it (see `collapse-guard-helpers.ts`:
the fixture dirs are exported `let`s, set by hooks that a `use…Repos()` call
registers in each file).

Retries don't wait in tests (#108). Every wait between attempts (lock retries,
`gh` retries, merge polling) goes through `retryWait` in `src/lib/retry-delay.ts`,
which waits `GH_STACK_TEST_RETRY_DELAY_MS` instead when that's set. The test
preload sets it to 0, and CLIs the tests spawn inherit it, so retries still
happen, just without the wait. `retry-delay.test.ts` fails on any `sleep`,
`setTimeout` or `setInterval` call elsewhere in src. A test that times a real
wait (a lock released after 250 ms) deletes the variable, as `git-lock.test.ts`
does.

## Release Process

When making changes, follow these steps:

1. **Update docs** — Keep `README.md` in sync with any command/flag changes
2. **Run tests** — `bun run test` (must pass before committing)
3. **Commit** — Use conventional commits
4. **Bump version** — Update `package.json` version + add entry to `CHANGELOG.md`
5. **Tag** — `git tag -a v0.x.y -m "Release v0.x.y — summary"`
6. **Build** — `bun run build`
7. **Push** — `git push && git push origin v0.x.y`
8. **Publish** — pushing the tag publishes. `.github/workflows/publish.yml` runs
   the checks on Linux, verifies the tag matches `package.json`, and publishes
   via npm trusted publishing (OIDC, no token). Watch it with `gh run watch`,
   then confirm with `npm view gh-stack version`. npm can take a minute or two
   to show a new version; wait rather than re-publishing.

The pre-push hook runs lint + typecheck + tests (output suppressed on success).
It skips them when the push only deletes branches or pushes tags (#106), so
`git push origin vX` and `git push origin --delete <branch>` return at once.
The prepublishOnly hook is a no-op since checks already ran on push.

The repo and the npm package belong to `iamclaudia-ai` (moved from `kiliman`
on 2026-11-14). Manual fallback (only if the workflow can't publish): `npm
whoami` must be a package owner (`npm owner ls gh-stack`), then `npm publish`
with that account's OTP. The trusted publisher on npmjs.com names the repo
(`iamclaudia-ai/gh-stack`) and the workflow file, so renaming `publish.yml` or
moving the repo breaks publishing until that setting is updated.
