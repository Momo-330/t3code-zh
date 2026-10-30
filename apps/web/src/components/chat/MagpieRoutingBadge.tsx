import { memo } from "react";
import { cn } from "~/lib/utils";

const MAGPIE_ROUTING_BADGE_LABEL = "经 magpie";

export const MagpieRoutingBadge = memo(function MagpieRoutingBadge(props: { className?: string }) {
  return (
    <span
      className={cn(
        "shrink-0 rounded-full border border-magpie-border/55 bg-magpie-surface/90 px-1.5 py-px text-3xs font-medium leading-none tracking-normal text-magpie-foreground",
        "dark:border-magpie-border-dark/35 dark:bg-magpie-surface-dark/70 dark:text-magpie-foreground-dark",
        props.className,
      )}
      aria-label="Routed via Magpie"
    >
      {MAGPIE_ROUTING_BADGE_LABEL}
    </span>
  );
});
