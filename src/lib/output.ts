// Plain-mode-aware wrapper over @clack/prompts.
//
// In plain mode (--plain flag or GH_STACK_YES=1), we strip the decorative
// chrome that makes gh-stack output painful for agents/log consumers:
//   - no intro/outro boxes
//   - no spinners (start/stop lines collapse to plain prints)
//   - no ANSI colors (picocolors auto-disables via NO_COLOR; we also strip
//     any residual escapes defensively)
//
// Interactive prompts (text, confirm, select) are unchanged by plain mode —
// plain mode is about output, not interactivity. Agents already pair --plain
// with --yes/GH_STACK_YES so the interactive paths aren't reached. If one IS
// reached with no TTY on stdin (#33), or from an agent's shell (#123), nothing
// can ever answer it, so we fail fast instead of blocking forever.
import * as clack from "@clack/prompts";
import { clearGitCache } from "./git.ts";

let _plain = false;
let stderrOnly = false;

export function setPlain(enabled: boolean): void {
  _plain = enabled;
}

/**
 * `--json` mode: plain output, all of it on stderr, so stdout carries only the
 * JSON document the command writes itself.
 */
export function setStderrOnly(): void {
  _plain = true;
  stderrOnly = true;
}

/** Plain-mode line: stdout normally, stderr in --json mode. */
function say(line: string): void {
  if (stderrOnly) console.error(line);
  else console.log(line);
}

/** A raw line of output (tree drawings, spacing), routed like the log calls. */
export function print(line = ""): void {
  say(_plain ? strip(line) : line);
}

export function isPlain(): boolean {
  return _plain;
}

const ANSI_RE = new RegExp(String.fromCharCode(27) + "\\[[0-9;]*m", "g");
function strip(s: string | undefined): string {
  return (s ?? "").replace(ANSI_RE, "");
}

// ── Interactive prompts ──
export const isCancel = clack.isCancel;

/**
 * The environment variable that marks this process as run by a coding agent,
 * or undefined for a person's shell. Claude Code exports `CLAUDECODE=1` to the
 * commands it runs, and Anima exports `ANIMA_SESSION_ID` to every agent session
 * it starts (Codex ones included, which set no `CLAUDECODE`).
 */
export function agentMarker(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.CLAUDECODE) return "CLAUDECODE";
  if (env.ANIMA_SESSION_ID) return "ANIMA_SESSION_ID";
  return undefined;
}

/**
 * Exit non-zero instead of prompting when nobody can answer: stdin isn't a TTY
 * (#33), or an agent runs this command (#123). Agents may run commands in a
 * tmux pane, where stdin is a TTY but no one is typing. Either way the prompt
 * would otherwise hang (holding the repo) until the caller's timeout kills it.
 */
function ensureInteractive(message: string): void {
  const marker = process.stdin.isTTY ? agentMarker() : undefined;
  if (process.stdin.isTTY && !marker) return;
  const reason = marker
    ? `${marker} is set, so an agent is running this and nobody will answer`
    : "stdin is not a TTY";
  console.error(
    `gh-stack: refusing to prompt — ${reason}.\n` +
      `  Prompt: ${strip(message)}\n` +
      `  Pass --yes (or set GH_STACK_YES=1) to confirm automatically.`,
  );
  process.exit(1);
}

// While a prompt waits, the user may change the repo from another terminal, so
// each one ends by dropping the git answers cached so far (#108).

export const text: typeof clack.text = (opts) => {
  ensureInteractive(opts.message);
  return clack.text(opts).finally(clearGitCache);
};

export const confirm: typeof clack.confirm = (opts) => {
  ensureInteractive(opts.message);
  return clack.confirm(opts).finally(clearGitCache);
};

export const select: typeof clack.select = (opts) => {
  ensureInteractive(opts.message);
  return clack.select(opts).finally(clearGitCache);
};

// ── Banner / error ──
export function intro(message?: string): void {
  if (_plain) {
    if (message) say(strip(message));
  } else {
    clack.intro(message);
  }
}

export function outro(message?: string): void {
  if (_plain) {
    if (message) say(strip(message));
  } else {
    clack.outro(message);
  }
}

export function cancel(message?: string): void {
  if (_plain) {
    if (message) console.error(strip(message));
  } else {
    clack.cancel(message);
  }
}

// ── log.* ──
export const log = {
  info: (msg: string) => (_plain ? say(strip(msg)) : clack.log.info(msg)),
  success: (msg: string) => (_plain ? say(strip(msg)) : clack.log.success(msg)),
  warn: (msg: string) => (_plain ? console.warn(strip(msg)) : clack.log.warn(msg)),
  error: (msg: string) => (_plain ? console.error(strip(msg)) : clack.log.error(msg)),
  step: (msg: string) => (_plain ? say(strip(msg)) : clack.log.step(msg)),
};

// ── Spinner ──
export interface Spinner {
  start: (msg?: string) => void;
  stop: (msg?: string, code?: number) => void;
  message: (msg?: string) => void;
}

export function spinner(): Spinner {
  if (!_plain) return clack.spinner() as Spinner;
  return {
    start: (msg) => {
      if (msg) say(strip(msg));
    },
    stop: (msg) => {
      if (msg) say(strip(msg));
    },
    message: (msg) => {
      if (msg) say(strip(msg));
    },
  };
}
