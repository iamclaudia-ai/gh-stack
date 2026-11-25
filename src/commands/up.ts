// gh-stack up — Move to child branch (upstack)
import * as p from "../lib/output.ts";
import pc from "picocolors";
import * as git from "../lib/git.ts";
import { findStackForBranch, getChildren, writeMetadata } from "../lib/metadata.ts";
import { ensureMetadata, checkoutOrExit } from "../lib/safety.ts";
import { chooseBranch } from "../lib/ui.ts";

export default async function up(args: string[]): Promise<void> {
  if (args.includes("--help")) {
    console.log(`
gh-stack up — Move to child branch (upstack)

USAGE
  gh-stack up [steps]

OPTIONS
  [steps]    Number of levels to move up (default: 1)
`);
    return;
  }

  const steps = parseInt(args[0] || "1", 10);
  if (isNaN(steps) || steps < 1) {
    p.cancel("Invalid step count");
    process.exit(1);
  }

  const meta = await ensureMetadata();
  let currentBranch = await git.currentBranch();
  const stackName = findStackForBranch(meta, currentBranch);

  if (!stackName) {
    p.cancel(`Branch ${pc.yellow(currentBranch)} is not in any stack`);
    process.exit(1);
  }

  const stack = meta.stacks[stackName]!;

  for (let i = 0; i < steps; i++) {
    const children = getChildren(stack, currentBranch);

    if (children.length === 0) {
      if (i === 0) {
        p.log.warn(`${pc.yellow(currentBranch)} is already at the top of the stack`);
      } else {
        p.log.info(`Reached top of stack at ${pc.yellow(currentBranch)} after ${i} step(s)`);
      }
      return;
    }

    let target: string;
    if (children.length === 1) {
      target = children[0]!;
    } else {
      target = await chooseBranch(
        stack,
        "Multiple children — which branch?",
        children,
        `Several branches sit on ${currentBranch}`,
      );
    }

    currentBranch = target;
  }

  await checkoutOrExit(currentBranch);

  // Update tracking
  stack.last_branch = currentBranch;
  meta.current_stack = stackName;
  await writeMetadata(meta);

  p.log.success(`On ${pc.yellow(currentBranch)}`);
}
