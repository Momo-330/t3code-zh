// Desktop-only Chinese UI: wraps user-visible literals in t("...") at build time.
//
// The transform lives here rather than in the sources so this fork stays
// mergeable with upstream. Only rendered text is touched: JSX child text and
// the string attributes that reach a screen reader, a label, or a placeholder.
import { parseSync } from "oxc-parser";

export interface LocalizeI18nPluginOptions {
  /** Absolute path of the module that exports t(). */
  readonly importPath: string;
}

const TRANSLATABLE_ATTRIBUTES = new Set([
  "aria-label",
  "label",
  "placeholder",
  "title",
  "alt",
  "hint",
  "description",
  "tooltip",
]);

// Components whose title/description props are translated inside the component.
const SELF_TRANSLATING_COMPONENTS = new Set(["SettingsRow", "SettingsSection"]);

const NOISE_PREFIX = /^(?:https?:|data:|\/|\.|#|@|--)/;
const CODE_CHARS = /[{}<>=;]/;

/** A single capitalized word, or a sentence containing real words. */
function isUiText(raw: string): boolean {
  const text = raw.replace(/\s+/g, " ").trim();
  if (text.length < 2 || text.length > 240) return false;
  if (!/[A-Za-z]/.test(text)) return false;
  if (CODE_CHARS.test(text)) return false;
  if (NOISE_PREFIX.test(text)) return false;
  // Tailwind utilities only: a class list has no lowercase words with spaces.
  if (
    /^(?:\S+:\S+|w-|h-|text-|bg-|p[xyltrb]?-|m[xyltrb]?-|flex|grid|gap-|rounded|border|shadow)/.test(
      text,
    ) &&
    !/\s[a-z]{3,}\b.*\s/.test(text) &&
    text.split(" ").length <= 6
  ) {
    // "text-sm" and "sm:w-6" are classes; "Text size" is a label.
    if (
      /^(?:\S+:\S+|(?:w|h|min-w|max-w|p[xyltrb]?|m[xyltrb]?|gap|rounded|text|bg|border|shadow)-)/.test(
        text,
      )
    ) {
      return false;
    }
  }
  // camelCase, snake_case, kebab-case, dotted paths, and bare identifiers are code.
  if (/^[A-Za-z_$][\w$]*(?:[.:][A-Za-z_$][\w$]*)*$/.test(text) && !/^[A-Z][a-z]+$/.test(text)) {
    return false;
  }
  if (!/\s/.test(text)) return !/^[a-z]/.test(text) && /^[A-Z][a-z]+$/.test(text);
  return /\b[a-z]{2}/.test(text);
}

function jsxAttributeStrings(
  node: Record<string, unknown>,
): ReadonlyArray<{ start: number; end: number; value: string; bare?: boolean }> {
  const found: Array<{ start: number; end: number; value: string; bare?: boolean }> = [];
  const attributes = node.attributes;
  if (!Array.isArray(attributes)) return found;
  // The component name lives on the parent opening element, one level up.
  const elementName = (node.name as { name?: string } | undefined)?.name;

  for (const attribute of attributes) {
    if (attribute?.type !== "JSXAttribute") continue;
    const name = attribute.name?.name;
    if (typeof name !== "string" || !TRANSLATABLE_ATTRIBUTES.has(name)) continue;
    if (
      elementName !== undefined &&
      SELF_TRANSLATING_COMPONENTS.has(elementName) &&
      (name === "title" || name === "description")
    ) {
      continue;
    }

    const value = attribute.value;
    // oxc spells string literals `Literal` (with `raw`); Babel-style `StringLiteral`
    // is kept too so the transform survives an AST change.
    if (
      (value?.type === "Literal" || value?.type === "StringLiteral") &&
      typeof value.value === "string"
    ) {
      if (isUiText(value.value)) {
        found.push({ start: value.start, end: value.end, value: value.value });
      }
      continue;
    }
    // prop={cond ? "A" : "B"} — only literals that are direct branches.
    if (value?.type === "JSXExpressionContainer") {
      const expression = value.expression;
      if (expression?.type === "ConditionalExpression") {
        for (const branch of [expression.consequent, expression.alternate]) {
          if (
            (branch?.type === "Literal" || branch?.type === "StringLiteral") &&
            typeof branch.value === "string" &&
            isUiText(branch.value)
          ) {
            // Inside an expression container the branch is a bare expression, so
            // no braces here; the container already provides them.
            found.push({
              start: branch.start,
              end: branch.end,
              value: branch.value,
              bare: true,
            });
          }
        }
      }
    }
  }
  return found;
}

/** Every offset in the file that must become t("..."), with its replacement. */
export function collectLocalizations(
  code: string,
  filename: string,
): ReadonlyArray<{ start: number; end: number; replacement: string }> {
  const parsed = parseSync(filename, code);
  const edits: Array<{ start: number; end: number; replacement: string }> = [];
  const seen = new Set<number>();

  // `asAttribute` keeps JSX attribute values brace-wrapped, which they require.
  const push = (start: number, end: number, value: string, asAttribute: boolean) => {
    if (seen.has(start)) return;
    seen.add(start);
    const literal = JSON.stringify(value.replace(/\s+/g, " ").trim());
    edits.push({
      start,
      end,
      replacement: asAttribute ? `{t(${literal})}` : `t(${literal})`,
    });
  };

  const visit = (node: unknown): void => {
    if (node === null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }

    const record = node as Record<string, unknown>;
    const type = record.type;

    if (type === "JSXOpeningElement") {
      for (const attribute of jsxAttributeStrings(record)) {
        push(attribute.start, attribute.end, attribute.value, attribute.bare !== true);
      }
    }

    if (type === "JSXExpressionContainer") {
      const expression = record.expression as Record<string, unknown> | undefined;
      const containerStart = record.start as number;
      const containerEnd = record.end as number;
      // Only bare literals and literal ternaries: those are display text, not logic.
      if (
        (expression?.type === "Literal" || expression?.type === "StringLiteral") &&
        typeof expression.value === "string" &&
        isUiText(expression.value)
      ) {
        const value = expression.value as string;
        if (!seen.has(containerStart)) {
          seen.add(containerStart);
          edits.push({
            start: containerStart,
            end: containerEnd,
            replacement: `{t(${JSON.stringify(value.replace(/\s+/g, " ").trim())})}`,
          });
        }
      } else if (expression?.type === "ConditionalExpression") {
        for (const branch of [
          expression.consequent as Record<string, unknown> | undefined,
          expression.alternate as Record<string, unknown> | undefined,
        ]) {
          if (
            (branch?.type === "Literal" || branch?.type === "StringLiteral") &&
            typeof branch.value === "string" &&
            isUiText(branch.value)
          ) {
            const value = branch.value as string;
            const start = branch.start as number;
            if (!seen.has(start)) {
              seen.add(start);
              edits.push({
                start,
                end: branch.end as number,
                // The container already supplies the braces around the ternary.
                replacement: `t(${JSON.stringify(value.replace(/\s+/g, " ").trim())})`,
              });
            }
          }
        }
      }
    }

    if (type === "JSXText" && typeof record.value === "string") {
      const raw = record.value;
      if (isUiText(raw)) {
        // Keep the surrounding whitespace outside the call so JSX spacing survives.
        const leading = raw.match(/^\s*/)?.[0] ?? "";
        const trailing = raw.match(/\s*$/)?.[0] ?? "";
        const core = raw.slice(leading.length, raw.length - trailing.length);
        if (isUiText(core)) {
          const value = core.replace(/\s+/g, " ").trim();
          const start = (record.start as number) + leading.length;
          const end = (record.end as number) - trailing.length;
          if (!seen.has(start)) {
            seen.add(start);
            edits.push({ start, end, replacement: `{t(${JSON.stringify(value)})}` });
          }
        }
      }
    }

    for (const key of Object.keys(record)) {
      if (key === "type" || key === "start" || key === "end") continue;
      visit(record[key]);
    }
  };

  visit(parsed.program);

  return edits;
}

/**
 * Applies the edits and adds the t import. Returns null when the file needs no
 * change, so the plugin can pass the original code through untouched.
 */
export function localizeModule(code: string, filename: string, importPath: string): string | null {
  const edits = collectLocalizations(code, filename);
  if (edits.length === 0) return null;

  let output = code;
  for (const edit of [...edits].sort((left, right) => right.start - left.start)) {
    output = `${output.slice(0, edit.start)}${edit.replacement}${output.slice(edit.end)}`;
  }

  const alreadyImported = new RegExp(
    `import\\s*\\{[^}]*\\bt\\b[^}]*\\}\\s*from\\s*["']${importPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']`,
  ).test(output);
  // A file that already imports t from anywhere must not gain a second binding.
  const importsTElsewhere = /import\s*\{[^}]*\bt\b[^}]*\}\s*from\s*["'][^"']*i18n["']/.test(output);
  if (alreadyImported || importsTElsewhere) return output;

  const specifier = JSON.stringify(importPath);
  output = `import { t } from ${specifier};\n${output}`;
  return output;
}
