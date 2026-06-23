import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";

import { cn } from "../../lib/utils";

const buttonVariants = cva(
  "inline-flex min-h-12 items-center justify-center gap-2 rounded text-sm font-bold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 disabled:pointer-events-none disabled:opacity-50",
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
        default: "px-4 py-2",
        sm: "px-3 py-2",
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
}

export function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: ButtonProps) {
  const Comp = asChild ? Slot : "button";
  return (
    <Comp
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  );
}
