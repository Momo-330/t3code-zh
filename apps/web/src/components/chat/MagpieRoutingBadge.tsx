import { memo } from "react";
import { cn } from "~/lib/utils";

export const MAGPIE_ROUTING_BADGE_LABEL = "经 magpie";

export const MagpieRoutingBadge = memo(function MagpieRoutingBadge(props: {
  className?: string;
}) {
  return (
    <span
      className={cn(
        "shrink-0 rounded-full border border-violet-300/55 bg-violet-100/90 px-1.5 py-px text-3xs font-medium leading-none tracking-normal text-violet-900",
        "dark:border-violet-500/35 dark:bg-violet-950/70 dark:text-violet-200",
        props.className,
      )}
      aria-label="Routed via Magpie"
    >
      {MAGPIE_ROUTING_BADGE_LABEL}
    </span>
  );
});
