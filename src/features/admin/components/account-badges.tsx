import { Badge } from "@/components/ui/badge";
import type { AccountApproval, UserRole } from "@/generated/prisma/enums";
import { cn } from "@/lib/utils";

/**
 * The two columns that used to be one.
 *
 * Rendered as separate badges rather than a single combined state, because
 * conflating them is precisely the mistake the role column exists to correct —
 * an APPROVED MEMBER and an APPROVED OPERATOR are not degrees of the same
 * thing, and a UI that showed one chip would invite the reader to rank them.
 */

const APPROVAL_PRESENTATION: Record<
  AccountApproval,
  { label: string; className: string }
> = {
  PENDING: {
    label: "Pending",
    className:
      "border-transparent bg-amber-500/12 text-amber-700 dark:text-amber-300",
  },
  APPROVED: {
    label: "Approved",
    className:
      "border-transparent bg-emerald-500/12 text-emerald-700 dark:text-emerald-300",
  },
  REJECTED: {
    label: "Rejected",
    className:
      "border-transparent bg-destructive/12 text-destructive dark:text-red-400",
  },
};

export function ApprovalBadge({
  approval,
  className,
}: {
  approval: AccountApproval;
  className?: string;
}) {
  const { label, className: toneClass } = APPROVAL_PRESENTATION[approval];

  return (
    <Badge variant="outline" className={cn(toneClass, className)}>
      {label}
    </Badge>
  );
}

/**
 * MEMBER renders as plain muted text rather than a coloured chip. It is the
 * default and the overwhelming majority of rows; giving it a badge of its own
 * would make a roster of ordinary accounts look like a page of warnings and
 * bury the one or two rows that are actually privileged.
 */
export function RoleBadge({
  role,
  className,
}: {
  role: UserRole;
  className?: string;
}) {
  if (role === "MEMBER") {
    return (
      <span className={cn("text-muted-foreground text-sm", className)}>
        Member
      </span>
    );
  }

  return (
    <Badge
      variant="outline"
      className={cn(
        "border-transparent bg-primary/12 text-primary font-medium",
        className,
      )}
    >
      Operator
    </Badge>
  );
}
