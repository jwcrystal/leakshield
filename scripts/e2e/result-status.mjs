/** Runner exceptions must fail the gate just like failed case assertions. */
export function resultExitCode(results) {
  return results.some(({ verdict }) => verdict === "fail" || verdict === "error") ? 1 : 0;
}
