/**
 * Ship-time bundler for `public/*.html` first paint (E1 remedy):
 * one ESM entry per page importing its
 * module scripts IN TAG ORDER → `<page>.bundle.js`, one `<script type="module">` in the HTML.
 *
 *     npm run bundle:public -- <dir>      # rewrites <dir>/public/*.html in place + writes bundles
 *
 * ⚠ It MUTATES the tree it is pointed at — only ever the DETACHED DEPLOY WORKTREE `scripts/ship.sh`
 * creates, never the repo working tree (dev still serves the loose authored modules, left in place).
 * Any esbuild failure ABORTS (exit 1): a half-bundled payload is a mixed-vintage deploy.
 */
import { globSync, readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { buildSync } from "esbuild";

/** `<script type="module" src="…">` with a src — relative srcs are the ones we bundle. */
const MODULE_SCRIPT_RE = /<script\b[^>]*\btype="module"[^>]*\bsrc="([^"]+)"[^>]*>\s*<\/script>/g;
const isRelative = (src: string): boolean => !/^([a-z]+:)?\/\//i.test(src) && !src.startsWith("/");

export function bundlePage(
  publicDir: string,
  htmlRel: string,
): { html: string; bundleRel: string | null; code: string } {
  const html = readFileSync(resolve(publicDir, htmlRel), "utf8");
  const hits = [...html.matchAll(MODULE_SCRIPT_RE)]
    .map((m) => ({ start: m.index, end: m.index + m[0].length, src: m[1]! }))
    .filter((h) => isRelative(h.src));
  if (hits.length === 0) return { html, bundleRel: null, code: "" };

  const page = basename(htmlRel, ".html");
  const bundleRel = `${page}.bundle.js`;
  // ONE synthetic entry, tag order preserved — pages share singleton modules across their scripts.
  const entry = hits.map((h) => `import ${JSON.stringify(h.src)};`).join("\n") + "\n";
  const result = buildSync({
    stdin: { contents: entry, resolveDir: publicDir, sourcefile: `${page}.entry.js`, loader: "js" },
    bundle: true,
    format: "esm",
    minify: true,
    write: false,
    target: "es2022",
  });
  // No `splitting`: a dynamic import() would emit extra chunks the CLI never writes — a partial deploy. Fail loud.
  if (result.outputFiles.length !== 1) throw new Error(`${page}: esbuild emitted ${result.outputFiles.length} files, expected 1 bundle`);
  const code = result.outputFiles[0]!.text;

  const bundleTag = `<script type="module" src="./${bundleRel}"></script>`;
  let out = "";
  let cursor = 0;
  hits.forEach((h, i) => {
    out += html.slice(cursor, h.start) + (i === 0 ? bundleTag : "");
    cursor = h.end;
  });
  out += html.slice(cursor);
  return { html: out, bundleRel, code };
}

// ─── CLI (deploy worktree only) ────────────────────────────────────────────────────────────
if (process.argv[1] && /bundle-public\.ts$/.test(process.argv[1])) {
  const target = resolve(process.argv[2] ?? ".");
  const publicDir = resolve(target, "public");
  const pages = globSync("*.html", { cwd: publicDir }).sort();
  let bundled = 0;
  for (const htmlRel of pages) {
    let res: ReturnType<typeof bundlePage>;
    try {
      res = bundlePage(publicDir, htmlRel);
    } catch (err) {
      console.error(`::error:: esbuild failed bundling ${htmlRel}: ${(err as Error).message}`);
      process.exit(1);
    }
    if (res.bundleRel === null) continue;
    writeFileSync(resolve(publicDir, res.bundleRel), res.code);
    writeFileSync(resolve(publicDir, htmlRel), res.html);
    bundled += 1;
  }
  if (bundled === 0) {
    console.error(`::error:: no public/*.html carried module scripts under ${target} — refusing a vacuous bundle pass`);
    process.exit(1);
  }
  console.log(`▶ bundled ${bundled}/${pages.length} public/ page(s) into per-page .bundle.js entries`);
}
