import { isElectron } from "../env";
import { zhCN } from "./zh-CN";

/** Desktop fork: the renderer UI is Chinese. Web tests keep English. */
const isChineseUi = isElectron;

export function t(english: string, vars?: Record<string, string | number>): string {
  const template = isChineseUi ? (zhCN[english] ?? english) : english;
  if (vars === undefined) return template;
  return template.replaceAll(/\{(\w+)\}/g, (_, key: string) => String(vars[key] ?? `{${key}}`));
}

/** Snooze presets build labels client-side ("In 2 hours", "Next Monday"), so no key exists. */
export function tSnoozePresetLabel(label: string): string {
  if (!isChineseUi) return label;
  const known = zhCN[label];
  if (known !== undefined) return known;
  const duration = /^In (\d+) (minute|hour|day)s?$/.exec(label);
  if (duration) {
    const unit = duration[2] === "minute" ? "分钟" : duration[2] === "hour" ? "小时" : "天";
    return `${duration[1]} ${unit}后`;
  }
  const nextDay = /^Next (\w+)$/.exec(label)?.[1];
  const translatedDay = nextDay === undefined ? undefined : zhCN[nextDay];
  if (translatedDay !== undefined) return `下${translatedDay}`;
  return label;
}
