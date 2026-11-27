/** `tsx scripts/test-budget-confirm.ts <offenders.json>` — T1's alone re-run, deferred by `T1_DEFER_ALONE`
 * (scripts/check.sh runs it after its parallel join). Exit 1 = a confirmed offender or an unreadable file. */
import { confirmDeferred } from "./test-budget-reporter.js";

const [path] = process.argv.slice(2);
if (!path) {
  process.stderr.write("usage: tsx scripts/test-budget-confirm.ts <offenders.json>\n");
  process.exit(2);
}
process.exitCode = confirmDeferred(path, process.cwd());
