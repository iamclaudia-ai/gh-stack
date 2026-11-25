// gh-stack checkout — Switch between branches or stacks
import * as p from "../lib/output.ts";
import pc from "picocolors";
import * as git from "../lib/git.ts";
import { writeMetadata, getOrderedBranches, findStackForBranch } from "../lib/metadata.ts";
import { ensureMetadata, checkoutOrExit } from "../lib/safety.ts";
import { selectBranch, selectStack } from "../lib/ui.ts";

const USAGE_HINT = `checkout takes a stack position (see ${pc.green("gh-stack log")}), a branch name, or --stack.`;

export default async function checkout(args: string[]): Promise<void> {
  const isStackMode = args.includes("--stack");

  if (args.includes("--help")) {
    console.log(`
gh-stack checkout — Switch branch or stack

USAGE
  gh-stack checkout <number>      Switch to branch by position (non-interactive)
  gh-stack checkout <branch>      Switch to a branch of any stack by name
  gh-stack checkout               Interactive branch picker (arrow keys)
  gh-stack checkout --stack       Switch between stacks (interactive)

  Under --yes the pickers can't ask, so name the branch.

ALIASES
  gh-stack co

EXAMPLES
  gh-stack checkout 1             Jump to first branch in stack (base)
  gh-stack checkout 2             Jump to second branch in stack
  gh-stack checkout deps/expo     Jump to deps/expo, in whichever stack has it

TIP
  Use 'gh-stack list' to see branch numbers.
`);
    return;
  }

  // An argument checkout can't use must never exit 0 (#159): an agent would
  // read that as a switch and carry on, on the wrong branch.
  const unknown = args.find((a) => a.startsWith("-") && a !== "--stack" && a !== "--help");
  const positional = args.filter((a) => !a.startsWith("-"));
  if (unknown || positional.length > 1 || (isStackMode && positional.length > 0)) {
    const what = unknown
      ? `Unknown option ${pc.yellow(unknown)}`
      : `Unexpected argument ${pc.yellow(positional.at(-1)!)}`;
    p.cancel(`${what}. ${USAGE_HINT}`);
    process.exit(1);
  }
  const target = positional[0];
  const numberArg = target && /^\d+$/.test(target) ? target : undefined;

  const meta = await ensureMetadata();
  const currentBranch = await git.currentBranch();

  if (isStackMode) {
    // ── Stack switching ──
    p.intro(pc.cyan("Switch Stack"));

    const stackName = await selectStack(meta, "Switch to stack");
    if (!stackName) {
      p.cancel("Cancelled");
      process.exit(0);
    }

    // Checkout the stack's last branch FIRST — only persist current_stack once
    // the switch actually lands, so a refused checkout (e.g. dirty tree) leaves
    // metadata pointing at the stack we're still on rather than the target.
    const stack = meta.stacks[stackName]!;
    const lastBranch = stack.last_branch;

    if (lastBranch && lastBranch !== currentBranch) {
      p.log.info(`Switching to stack ${pc.yellow(stackName)}`);
      p.log.info(`Checking out ${pc.yellow(lastBranch)}`);
      await checkoutOrExit(lastBranch);
    }

    meta.current_stack = stackName;
    await writeMetadata(meta);

    p.outro(pc.green(`Switched to stack ${pc.yellow(stackName)}`));
  } else {
    // ── Branch switching ──
    // A branch named outright belongs to its own stack, which may not be the
    // current one; otherwise the current branch's stack.
    const named = target && !numberArg ? target : undefined;
    let stackName = named
      ? findStackForBranch(meta, named)
      : findStackForBranch(meta, currentBranch);
    if (named && !stackName) {
      p.cancel(
        `${pc.yellow(named)} isn't a branch of any stack. ${USAGE_HINT}\n\n  A branch outside the stacks: ${pc.green(`git checkout ${named}`)}`,
      );
      process.exit(1);
    }
    if (!stackName) stackName = meta.current_stack;

    if (!stackName || !meta.stacks[stackName]) {
      p.cancel(`No active stack found.\n\n  Create one with:\n    ${pc.green("gh-stack init")}`);
      process.exit(1);
    }

    const stack = meta.stacks[stackName]!;
    const ordered = getOrderedBranches(stack);

    if (ordered.length === 0) {
      p.cancel("No branches in this stack");
      process.exit(1);
    }

    let targetBranch: string | null = null;

    if (named) {
      targetBranch = named;
    } else if (numberArg) {
      // Switch by number
      const index = parseInt(numberArg, 10) - 1;
      if (index < 0 || index >= ordered.length) {
        p.cancel(`Invalid branch number. Valid range: 1-${ordered.length}`);
        process.exit(1);
      }
      targetBranch = ordered[index]!;
    } else {
      // Interactive selector
      targetBranch = await selectBranch(
        stack,
        "Switch to branch",
        currentBranch,
        `Name it instead: ${pc.green("gh-stack checkout <number|branch>")}.`,
      );
    }

    if (!targetBranch) {
      p.cancel("Cancelled");
      process.exit(0);
    }

    if (targetBranch === currentBranch) {
      p.log.info(`Already on ${pc.yellow(targetBranch)}`);
      return;
    }

    p.log.info(`Switching to ${pc.yellow(targetBranch)}`);
    await checkoutOrExit(targetBranch);

    // Update last_branch
    stack.last_branch = targetBranch;
    meta.current_stack = stackName;
    await writeMetadata(meta);

    p.log.success(`On branch ${pc.yellow(targetBranch)}`);
  }
}
