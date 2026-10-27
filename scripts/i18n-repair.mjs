// Repairs the unwrap pass: a JSX expression container's inner ternary branches
// must not carry their own braces. `? {t("X")} :` becomes `? t("X") :`.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const WRITE = process.argv.includes("--write");
const root = "apps/web/src";

function walk(dir, out = []) {
  for (const entry of NodeFS.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const full = NodePath.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      walk(full, out);
    } else if (/\.tsx$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

// `? {` or `: {` followed by t("...") and a closing brace that ends the branch.
const BRACED_BRANCH = /([?:])\s*\{t\(("(?:[^"\\]|\\.)*")\)\}/g;
// `import { t } from "~/i18n";` duplicates the relative import; keep the relative one.
const ALIAS_IMPORT = /^import \{ t \} from "~\/i18n";\n/m;

let files = 0;
let repairs = 0;
let imports = 0;
const touched = [];

for (const file of walk(root)) {
  const source = NodeFS.readFileSync(file, "utf8");
  let output = source;
  let count = 0;

  output = output.replace(BRACED_BRANCH, (match, operator, literal) => {
    count += 1;
    return `${operator} ${literal}`;
  });

  let removedImport = 0;
  if (/import \{ t \} from "\.\.\//.test(output) && ALIAS_IMPORT.test(output)) {
    output = output.replace(ALIAS_IMPORT, "");
    removedImport = 1;
  }

  if (count === 0 && removedImport === 0) continue;
  repairs += count;
  imports += removedImport;
  files += 1;
  touched.push(
    `${file.replaceAll("\\", "/").replace("apps/web/src/", "")} (${count}+${removedImport})`,
  );
  if (WRITE) NodeFS.writeFileSync(file, output, "utf8");
}

console.log(
  `${WRITE ? "Repaired" : "Would repair"} ${repairs} ternary branches, ${imports} duplicate imports, ${files} files`,
);
for (const file of touched.slice(0, 30)) console.log(`  ${file}`);
