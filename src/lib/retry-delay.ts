// Waits between retries, and how the test suite skips them (#108).
//
// gh-stack retries what fails transiently: git locks held by another process,
// `gh pr view` and `gh pr edit --base` calls, a trunk fetch that doesn't hold a
// fresh merge yet, a merge GitHub is still recomputing. Each waits between
// attempts, and the tests exercise those paths on purpose, so the suite used to
// sleep ~40s for real. Most of those tests run the CLI as a subprocess, which a
// setter can't reach, so the override is an environment variable.
//
// GH_STACK_TEST_RETRY_DELAY_MS=<n> replaces every wait with n ms. The number of
// attempts doesn't change, so tests still see each retry happen. The test
// preload sets it to 0 for the whole suite (after it clears the developer's own
// GH_STACK_* variables), and CLIs the tests spawn inherit it. It's for tests
// only: not in the README or `gh-stack config`, and nothing reads GH_STACK_*
// variables by prefix, so it applies only when set by this exact name.
//
// Every wait in src goes through retryWait; retry-delay.test.ts fails on a
// `Bun.sleep` anywhere else.

export const TEST_RETRY_DELAY_ENV = "GH_STACK_TEST_RETRY_DELAY_MS";

/**
 * The wait to use for `ms`: `ms` itself, or the test override when
 * GH_STACK_TEST_RETRY_DELAY_MS holds a whole number. Any other value is
 * ignored. Read on every call, so a test can change it between retries.
 */
export function retryDelay(ms: number): number {
  const override = process.env[TEST_RETRY_DELAY_ENV];
  return override !== undefined && /^\d+$/.test(override) ? Number(override) : ms;
}

/**
 * Wait `ms` before the next attempt (or the test override instead), and return
 * how long it waited. Passing a delay already run through retryDelay is fine:
 * the override replaces whatever it's given.
 */
export async function retryWait(ms: number): Promise<number> {
  const wait = retryDelay(ms);
  await Bun.sleep(wait);
  return wait;
}
