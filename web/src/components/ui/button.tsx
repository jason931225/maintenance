import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";

import { cn } from "../../lib/utils";

const buttonVariants = cva(
  // No height in the root: each `size` owns its own min-height so a compact
  // size is never forced back up to 48px. Keep shared shape/typography/focus.
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded font-bold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        default:
          "bg-signal text-ink hover:bg-signal-dark focus-visible:outline-ink",
        secondary:
          "border border-ink bg-white text-ink hover:bg-muted-panel focus-visible:outline-ink",
        ghost:
          "bg-transparent text-steel hover:bg-muted-panel hover:text-ink focus-visible:outline-ink",
        destructive:
          "bg-red-700 text-white hover:bg-red-800 focus-visible:outline-red-700",
      },
      size: {
        // Primary form/page actions: full 48px tap target.
        default: "min-h-12 px-4 py-2 text-sm",
        // Dense table/action rows: compact 36px but still a comfortable target.
        sm: "min-h-9 px-3 py-1.5 text-sm",
        // Tightest action chips (overflow menus, inline rows): 32px AA minimum.
        xs: "min-h-8 px-2 py-1 text-xs",
        icon: "h-12 w-12 p-0",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
  ref?: React.Ref<HTMLButtonElement>;
}

export function Button({
  className,
  variant,
  size,
  asChild = false,
  ref,
  ...props
}: ButtonProps) {
  const Comp = asChild ? Slot : "button";
  return (
    <Comp
      ref={ref}
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  );
}
