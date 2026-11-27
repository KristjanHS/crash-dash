/**
 * Ship-time minifier for `public/*.js` (rung 8, P-3)
 * and `public/*.css`.
 *
 *     npm run minify:public -- <dir>      # rewrites <dir>/public/**\/*.{js,css} in place
 *
 * ⚠ It MUTATES the tree it is pointed at, so it is only ever pointed at the DETACHED DEPLOY
 * WORKTREE `scripts/ship.sh` §5 creates — never at the repo working tree. `public/*.js` stays
 * exactly what is authored and what dev serves; only the deployed copy is minified.
 *
 * Minify ONLY: `format: "esm"` + `loader: "js"` (and `loader: "css"`, no `target` = no syntax lowering) keep
 * it a per-file syntactic transform. No bundling,
 * no module-graph rewrite, no content hashing, no sourcemaps — filenames and import specifiers are
 * untouched, so the minified tree is a drop-in.
 *
 * Any esbuild failure ABORTS (exit 1). A partially-minified payload would be a silent mixed-vintage
 * deploy, which is worse than not shipping.
 */
import { globSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { transformSync } from "esbuild";

const minifyPublic = (source: string, rel: string): string =>
  rel.endsWith(".css")
    ? transformSync(source, { minify: true, loader: "css" }).code
    : transformSync(source, { minify: true, format: "esm", loader: "js", target: "es2022" }).code;

const target = resolve(process.argv[2] ?? ".");
const js = globSync("public/**/*.js", { cwd: target }).filter((f) => !f.endsWith(".test.js"));
const css = globSync("public/**/*.css", { cwd: target });
const files = [...js, ...css].sort();

if (js.length === 0 || css.length === 0) {
  console.error(`::error:: no public/ .js or .css files under ${target} — refusing a vacuous minify pass`);
  process.exit(1);
}

let before = 0;
let after = 0;
for (const rel of files) {
  const abs = resolve(target, rel);
  const src = readFileSync(abs, "utf8");
  let out: string;
  try {
    out = minifyPublic(src, rel);
  } catch (err) {
    console.error(`::error:: esbuild failed on ${rel}: ${(err as Error).message}`);
    process.exit(1);
  }
  before += Buffer.byteLength(src);
  after += Buffer.byteLength(out);
  writeFileSync(abs, out);
}

const pct = (((before - after) / before) * 100).toFixed(1);
console.log(`▶ minified ${js.length} .js + ${css.length} .css public/ files: ${before} → ${after} raw bytes (−${pct}%)`);
