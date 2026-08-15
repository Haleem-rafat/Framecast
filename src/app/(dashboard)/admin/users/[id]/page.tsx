import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, ShieldAlert } from "lucide-react";

import { PageHeader } from "@/components/shared/page-header";
import { RelativeTime } from "@/components/shared/relative-time";
import { Reveal } from "@/components/shared/reveal";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  ApprovalBadge,
  RoleBadge,
} from "@/features/admin/components/account-badges";
import { AdminVideoTable } from "@/features/admin/components/admin-video-table";
import { formatBytes } from "@/features/admin/format";
import type {
  AdminChannelSummary,
  AdminCredentialSummary,
  AdminProjectSummary,
  AdminPublicationSummary,
  AdminUserDetail,
} from "@/features/admin/types";
import { NotFoundError } from "@/lib/errors";
import { requireOperator } from "@/server/session";
import { adminService } from "@/services/admin.service";

export const metadata: Metadata = { title: "Account" };

interface AdminUserPageProps {
  params: Promise<{ id: string }>;
}

/**
 * One account, in enough detail to answer "what is this person doing" and
 * "why is their video stuck".
 *
 * Read-only, deliberately and completely. There is no button on this page that
 * changes anybody's data: seeing someone's records is one privilege and
 * editing them is another, and only the first was asked for. The single
 * cross-user write in the product is approve/reject, which stays at
 * /approvals where the rows are the accounts actually waiting on a decision.
 *
 * Opening this page writes an audit row naming the operator, the account they
 * opened and the moment — see `AdminService.getUser`. That is not an optional
 * extra hung off the side: the audit happens inside the read, so there is no
 * way to reach this data without leaving the record that would answer a user
 * asking whether their account was looked at.
 */
export default async function AdminUserPage({ params }: AdminUserPageProps) {
  const operator = await requireOperator();
  const { id } = await params;

  let detail: AdminUserDetail;
  try {
    detail = await adminService.getUser(operator.id, id);
  } catch (error) {
    // A url with an id that no longer exists is a 404, not a crash. Anything
    // else is a real fault and belongs in the error boundary.
    if (error instanceof NotFoundError) notFound();
    throw error;
  }

  const { user } = detail;
  const isSelf = operator.id === user.id;

  return (
    <>
      <div>
        <Button variant="ghost" size="sm" asChild className="-ml-2">
          <Link href="/admin">
            <ArrowLeft />
            All accounts
          </Link>
        </Button>
      </div>

      <PageHeader
        title={user.name}
        description={user.email}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <ApprovalBadge approval={user.approval} />
            <RoleBadge role={user.role} />
          </div>
        }
      />

      {!isSelf && (
        // Said out loud, on the page, every time. An operator should never be
        // able to claim they did not realise this was somebody else's data or
        // that the visit went unrecorded.
        <p className="text-muted-foreground flex items-start gap-2 text-sm">
          <ShieldAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span>
            This is another person&rsquo;s account. Opening it has been recorded
            against your own activity log as <code>admin.user.view</code>.
          </span>
        </p>
      )}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <FactCard label="Registered">
          <RelativeTime date={user.createdAt} />
        </FactCard>
        <FactCard label="Approved">
          {user.approvedAt ? (
            <RelativeTime date={user.approvedAt} />
          ) : (
            <span className="text-muted-foreground">Never</span>
          )}
        </FactCard>
        <FactCard label="Last active">
          {user.lastActiveAt ? (
            <RelativeTime date={user.lastActiveAt} />
          ) : (
            <span className="text-muted-foreground">Never</span>
          )}
        </FactCard>
        <FactCard label="Stored assets">
          <span className="font-mono">{formatBytes(detail.storageBytes)}</span>
        </FactCard>
      </div>

      <Section
        title="Videos"
        count={detail.videos.length}
        empty="This account has never created a video."
      >
        <Reveal>
          <AdminVideoTable videos={detail.videos} />
        </Reveal>
      </Section>

      <Section
        title="Projects"
        count={detail.projects.length}
        empty="No projects."
      >
        <ul className="divide-y rounded-lg border">
          {detail.projects.map((project) => (
            <ProjectRow key={project.id} project={project} />
          ))}
        </ul>
      </Section>

      <Section
        title="Channels"
        count={detail.channels.length}
        empty="No YouTube channels connected."
      >
        <ul className="divide-y rounded-lg border">
          {detail.channels.map((channel) => (
            <ChannelRow key={channel.id} channel={channel} />
          ))}
        </ul>
      </Section>

      <Section
        title="Publications"
        count={detail.publications.length}
        empty="Nothing has been published from this account."
      >
        <ul className="divide-y rounded-lg border">
          {detail.publications.map((publication) => (
            <PublicationRow key={publication.id} publication={publication} />
          ))}
        </ul>
      </Section>

      <Section
        title="Provider credentials"
        count={detail.credentials.length}
        empty="No provider keys saved."
      >
        {/* That a key exists, its label, and whether it last tested green.
         * Never the key, and never its last four characters — see the header
         * of src/features/admin/types.ts. Nothing on this page decrypts. */}
        <ul className="divide-y rounded-lg border">
          {detail.credentials.map((credential) => (
            <CredentialRow key={credential.id} credential={credential} />
          ))}
        </ul>
      </Section>

      <Section
        title="Recent activity"
        count={detail.recentActivity.length}
        empty="Nothing recorded yet."
      >
        {/* Action, level and message. `metadata` is deliberately not fetched:
         * in this deployment it carries password-reset URLs, so rendering it
         * would turn reading someone's history into taking over their
         * account. */}
        <ul className="divide-y rounded-lg border">
          {detail.recentActivity.map((entry) => (
            <li
              key={entry.id}
              className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-3 py-2 text-sm"
            >
              <code className="text-xs">{entry.action}</code>
              {entry.level !== "INFO" && (
                <Badge
                  variant="outline"
                  className={
                    entry.level === "ERROR"
                      ? "border-transparent bg-destructive/12 text-destructive dark:text-red-400"
                      : "border-transparent bg-amber-500/12 text-amber-700 dark:text-amber-300"
                  }
                >
                  {entry.level}
                </Badge>
              )}
              <span className="text-muted-foreground min-w-0 flex-1 truncate">
                {entry.message}
              </span>
              <RelativeTime
                date={entry.createdAt}
                className="text-muted-foreground text-xs"
              />
            </li>
          ))}
        </ul>
      </Section>
    </>
  );
}

function FactCard({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-muted-foreground text-sm font-medium">
          {label}
        </CardTitle>
      </CardHeader>
      <CardContent className="text-sm">{children}</CardContent>
    </Card>
  );
}

/**
 * A heading, a count, and either the content or one sentence saying there is
 * none. The count is in the heading rather than beside the rows because an
 * empty section still has to say which section is empty.
 */
function Section({
  title,
  count,
  empty,
  children,
}: {
  title: string;
  count: number;
  empty: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2">
        <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
        <Badge variant="secondary" className="font-mono">
          {count}
        </Badge>
      </div>
      {count === 0 ? (
        <p className="text-muted-foreground rounded-lg border border-dashed px-3 py-6 text-center text-sm">
          {empty}
        </p>
      ) : (
        children
      )}
    </section>
  );
}

function ProjectRow({ project }: { project: AdminProjectSummary }) {
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm">
      <span className="min-w-0 flex-1 truncate font-medium">{project.name}</span>
      <Badge variant="outline">{project.status}</Badge>
      {project.deletedAt && <Badge variant="secondary">Deleted</Badge>}
      <span className="text-muted-foreground font-mono text-xs">
        {project.videoCount} video{project.videoCount === 1 ? "" : "s"}
      </span>
      <RelativeTime
        date={project.createdAt}
        className="text-muted-foreground text-xs"
      />
    </li>
  );
}

function ChannelRow({ channel }: { channel: AdminChannelSummary }) {
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm">
      <span className="min-w-0 flex-1 truncate font-medium">
        {channel.title}
        {channel.handle && (
          <span className="text-muted-foreground ml-2 text-xs">
            {channel.handle}
          </span>
        )}
      </span>
      {!channel.isActive && <Badge variant="secondary">Inactive</Badge>}
      {channel.deletedAt && <Badge variant="secondary">Disconnected</Badge>}
      {/* Whether the OAuth grant has lapsed, never the tokens themselves —
       * `Channel.accessToken`/`refreshToken` are not selected by the admin
       * service at all. An expired grant is the usual reason a publish fails. */}
      {channel.tokenExpired && (
        <Badge
          variant="outline"
          className="border-transparent bg-amber-500/12 text-amber-700 dark:text-amber-300"
        >
          Token expired
        </Badge>
      )}
      <span className="text-muted-foreground font-mono text-xs">
        {channel.publicationCount} published
      </span>
      <RelativeTime
        date={channel.connectedAt}
        className="text-muted-foreground text-xs"
      />
    </li>
  );
}

function PublicationRow({
  publication,
}: {
  publication: AdminPublicationSummary;
}) {
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm">
      <span className="min-w-0 flex-1 truncate font-medium">
        {publication.title}
      </span>
      <span className="text-muted-foreground truncate text-xs">
        {publication.channelTitle}
      </span>
      <Badge
        variant="outline"
        className={
          publication.status === "FAILED"
            ? "border-transparent bg-destructive/12 text-destructive dark:text-red-400"
            : undefined
        }
      >
        {publication.status}
      </Badge>
      <Badge variant="secondary">{publication.visibility}</Badge>
      {publication.thumbnailError && (
        <span
          className="text-muted-foreground truncate text-xs"
          title={publication.thumbnailError}
        >
          thumbnail: {publication.thumbnailError}
        </span>
      )}
      {publication.error && (
        <span
          className="text-destructive min-w-0 truncate text-xs"
          title={publication.error}
        >
          {publication.error}
        </span>
      )}
      {publication.publishedAt && (
        <RelativeTime
          date={publication.publishedAt}
          className="text-muted-foreground text-xs"
        />
      )}
    </li>
  );
}

function CredentialRow({
  credential,
}: {
  credential: AdminCredentialSummary;
}) {
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm">
      <span className="min-w-0 flex-1 truncate font-medium">
        {credential.provider}
      </span>
      {credential.label && (
        <span className="text-muted-foreground truncate text-xs">
          {credential.label}
        </span>
      )}
      {/* No value and no tail — the point of this row is that a key is
       * present, not what it is. */}
      <Badge variant="secondary">Key saved</Badge>
      {credential.deletedAt ? (
        <Badge variant="secondary">Revoked</Badge>
      ) : !credential.isActive ? (
        <Badge variant="secondary">Inactive</Badge>
      ) : null}
      {credential.lastTestedAt ? (
        <span
          className={
            credential.lastTestOk
              ? "text-muted-foreground text-xs"
              : "text-destructive text-xs"
          }
        >
          {credential.lastTestOk ? "passed" : "failed"}{" "}
          <RelativeTime date={credential.lastTestedAt} />
        </span>
      ) : (
        <span className="text-muted-foreground text-xs">never tested</span>
      )}
    </li>
  );
}
