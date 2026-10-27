// Removes the mechanical t() wrapping from source files, leaving the English
// literals exactly as upstream wrote them. Used when the transform moves into
// the build pipeline.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const WRITE = process.argv.includes("--write");
const root = "apps/web/src";
const skipDirs = new Set(["node_modules", "i18n", "__tests__", "test"]);

function walk(dir, out = []) {
  for (const entry of NodeFS.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const full = NodePath.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (skipDirs.has(entry.name)) continue;
      walk(full, out);
    } else if (/\.(tsx|ts)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

// t("literal") -> "literal"; t("literal", {...}) is left alone because it carries placeholders.
const SIMPLE_CALL = /\bt\(("(?:[^"\\]|\\.)*")\)/g;

let files = 0;
let calls = 0;
const kept = [];
for (const file of walk(root)) {
  const source = NodeFS.readFileSync(file, "utf8");
  if (!SIMPLE_CALL.test(source)) continue;
  SIMPLE_CALL.lastIndex = 0;

  let count = 0;
  let output = source.replace(SIMPLE_CALL, (match, literal) => {
    count += 1;
    return literal;
  });
  if (count === 0) continue;

  // A JSX attribute needs braces once it stops being a literal expression.
  // `attr={"text"}` is valid but noisy, so collapse it back to attr="text".
  output = output.replace(/(\s[\w-]+)=\{("(?:[^"\\]|\\.)*")\}/g, "$1=$2");
  // JSX child `{"text"}` -> `text`
  output = output.replace(/\{("(?:[^"\\]|\\.)*")\}/g, (match, literal) => {
    const value = JSON.parse(literal);
    // Only bare text is safe; anything with braces or angle brackets stays a expression.
    if (/[{}<>]/.test(value)) return match;
    return value;
  });

  // Drop the import when nothing else uses t().
  if (!/\bt\(/.test(output)) {
    output = output.replace(/\nimport \{ t \} from "[^"]*i18n";/g, "");
    // A template call like t("X", {...}) keeps the import; this branch means none remain.
  } else {
    kept.push(file.replaceAll("\\", "/").replace("apps/web/src/", ""));
  }

  files += 1;
  calls += count;
  if (WRITE) NodeFS.writeFileSync(file, output, "utf8");
}

console.log(`${WRITE ? "Removed" : "Would remove"} ${calls} t() calls across ${files} files`);
console.log(`files still using t(): ${kept.length}`);
for (const file of kept.slice(0, 40)) console.log(`  ${file}`);
