import { isElectron } from "../env";
import { zhCN } from "./zh-CN";

/** Desktop fork: the renderer UI is Chinese. Web tests keep English. */
const isChineseUi = isElectron;

export function t(english: string, vars?: Record<string, string | number>): string {
  const template = isChineseUi ? (zhCN[english] ?? english) : english;
  if (vars === undefined) return template;
  return template.replaceAll(/\{(\w+)\}/g, (_, key: string) => String(vars[key] ?? `{${key}}`));
}
