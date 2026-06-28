import type * as React from "react";

import { Card } from "../../components/ui/card";
import { cn } from "../../lib/utils";

export function ObjectViewScaffold({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("grid gap-5", className)} {...props} />;
}

interface ObjectViewPanelProps
  extends Omit<React.HTMLAttributes<HTMLDivElement>, "title"> {
  title?: React.ReactNode;
  description?: React.ReactNode;
}

export function ObjectViewPanel({
  title,
  description,
  children,
  className,
  ...props
}: ObjectViewPanelProps) {
  return (
    <Card className={cn("grid gap-3", className)} {...props}>
      {title || description ? (
        <div className="grid gap-1">
          {title ? (
            <h2 className="text-lg font-semibold text-ink">{title}</h2>
          ) : null}
          {description ? (
            <p className="text-sm text-steel">{description}</p>
          ) : null}
        </div>
      ) : null}
      {children}
    </Card>
  );
}

export function ObjectViewProperties({
  className,
  ...props
}: React.HTMLAttributes<HTMLDListElement>) {
  return <dl className={cn("grid gap-3 sm:grid-cols-2", className)} {...props} />;
}

interface ObjectViewFieldProps {
  label: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}

export function ObjectViewField({
  label,
  children,
  className,
}: ObjectViewFieldProps) {
  return (
    <div className={className}>
      <dt className="text-sm font-semibold text-steel">{label}</dt>
      <dd className="text-ink">{children}</dd>
    </div>
  );
}
