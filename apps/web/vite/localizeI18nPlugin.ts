import type { Plugin } from "vite-plus";

import { localizeModule } from "./localizeI18n";

/**
 * Desktop fork: the web UI reads Chinese. The transform runs on both serve and
 * build so `vp dev` and the packaged app agree, and it only fires when
 * T3CODE_WEB_LOCALE=zh-CN, leaving tests and upstream builds in English.
 */
export function localizeI18nPlugin(): Plugin {
  const enabled = process.env.T3CODE_WEB_LOCALE?.trim() === "zh-CN";
  return {
    name: "t3code:localize-i18n",
    enforce: "pre",
    transform(code, id) {
      if (!enabled) return null;
      const [filename] = id.split("?", 1);
      if (filename === undefined || !/\.[jt]sx$/.test(filename)) return null;
      if (filename.includes("/node_modules/") || filename.includes("/i18n/")) return null;
      // The import must be relative so the bundle resolves the same module in dev and build.
      const relative = relativeI18nSpecifier(filename);
      if (relative === null) return null;
      const output = localizeModule(code, filename, relative);
      return output === null ? null : { code: output, map: null };
    },
  };
}

/** src/components/x.tsx -> ../../i18n, src/x.tsx -> ../i18n */
function relativeI18nSpecifier(filename: string): string | null {
  const normalized = filename.replaceAll("\\", "/");
  const marker = "/src/";
  const index = normalized.lastIndexOf(marker);
  if (index < 0) return null;
  const depth = normalized.slice(index + marker.length).split("/").length - 1;
  return `${"../".repeat(depth)}i18n`;
}
