import type {
  AccountApproval,
  PublishStatus,
  RenderStatus,
  ShortStatus,
  UserRole,
  VideoStatus,
} from "@/generated/prisma/enums";

/**
 * What the operator is allowed to see about other people, stated as types.
 *
 * These interfaces are the contract `adminService` fills and the admin pages
 * render, and they are deliberately narrow. Every one of them is a hand-written
 * shape rather than a `Prisma.UserGetPayload<...>`, because a derived type
 * grows a new field the moment somebody adds a column — and the columns most
 * likely to be added to these tables are the sensitive ones. Writing the shape
 * out means a new secret has to be typed in here, by a person, before it can
 * reach a page.
 *
 * ## What is deliberately absent, and why
 *
 * - `ProviderCredential.encryptedKey` — the AES-256-GCM ciphertext of a real
 *   API key. Nothing in the admin path imports `decryptSecret`.
 * - `ProviderCredential.keyLastFour` — not the key, but four characters of it,
 *   and the operator's own /providers page is the place that has a reason to
 *   show them. Seeing that a credential *exists* is what answers "why is this
 *   person's render failing"; seeing its tail answers nothing.
 * - `Channel.accessToken` / `refreshToken` — a YouTube OAuth pair is
 *   upload permission for somebody else's channel. Its own schema comment says
 *   these are never selected into a client payload, and this is a client
 *   payload.
 * - The whole `Account` table — Better Auth keeps the password hash and the
 *   Google OAuth tokens there. No admin query touches it.
 * - `Session.token` — a live session cookie is an impersonation primitive.
 * - `ActivityLog.metadata` — this one is not obvious and is the most dangerous
 *   of the set. `accountService.recordPasswordResetRequest` writes the full
 *   password-reset URL into `metadata.resetUrl`, because this deployment has
 *   no email transport and the log row *is* the delivery mechanism. Rendering
 *   metadata on a cross-user view would turn "read someone's activity" into
 *   "take over their account". `message` is carried and `metadata` is not.
 * - Script content, narration text and generated descriptions. The question
 *   this view answers is "what is this person doing and why is it stuck", not
 *   "what did they write".
 */

/** One row of the /admin user list. */
export interface AdminUserSummary {
  id: string;
  name: string;
  email: string;
  approval: AccountApproval;
  role: UserRole;
  createdAt: Date;
  approvedAt: Date | null;
  projectCount: number;
  videoCount: number;
  channelCount: number;
  /**
   * When this account last did anything the studio recorded — the newest
   * `ActivityLog.createdAt` attributed to them. Null for an account that has
   * registered and never acted, which is exactly the row an operator wants to
   * be able to spot.
   */
  lastActiveAt: Date | null;
}

export interface AdminProjectSummary {
  id: string;
  name: string;
  status: string;
  videoCount: number;
  createdAt: Date;
  deletedAt: Date | null;
}

/** Enough to answer "why is this person's video stuck". */
export interface AdminVideoSummary {
  id: string;
  title: string;
  status: VideoStatus;
  projectName: string;
  /** Denormalised UI hint on Video; the durable record is VideoStatusEvent. */
  failureReason: string | null;
  attempts: number;
  /** Non-null and in the future means a worker holds it; in the past means the holder died. */
  leaseExpiresAt: Date | null;
  cancelRequestedAt: Date | null;
  durationSeconds: number | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
  /** The most recent render attempt, which is where a stall usually explains itself. */
  latestRender: {
    status: RenderStatus;
    progress: number;
    error: string | null;
    startedAt: Date | null;
    finishedAt: Date | null;
  } | null;
  shortCount: number;
  /** Shorts not in READY, so a half-cut set is visible without a second page. */
  shortsUnfinished: number;
}

export interface AdminChannelSummary {
  id: string;
  title: string;
  handle: string | null;
  youtubeChannelId: string;
  isActive: boolean;
  /**
   * Whether the OAuth grant has lapsed — derived here from `tokenExpiresAt`
   * rather than shipping the timestamp, and never the tokens themselves.
   */
  tokenExpired: boolean;
  connectedAt: Date;
  deletedAt: Date | null;
  publicationCount: number;
}

export interface AdminPublicationSummary {
  id: string;
  title: string;
  status: PublishStatus;
  visibility: string;
  channelTitle: string;
  youtubeVideoId: string | null;
  scheduledFor: Date | null;
  publishedAt: Date | null;
  error: string | null;
  thumbnailApplied: boolean;
  thumbnailError: string | null;
}

/**
 * That a credential exists, and nothing that could be used as one. See the
 * header — no ciphertext, no last four.
 */
export interface AdminCredentialSummary {
  id: string;
  provider: string;
  label: string | null;
  isActive: boolean;
  lastTestedAt: Date | null;
  lastTestOk: boolean | null;
  createdAt: Date;
  deletedAt: Date | null;
}

/** Action + level + message. Never `metadata` — see the header. */
export interface AdminActivityEntry {
  id: string;
  action: string;
  level: string;
  message: string | null;
  createdAt: Date;
}

export interface AdminUserDetail {
  user: AdminUserSummary;
  projects: AdminProjectSummary[];
  videos: AdminVideoSummary[];
  channels: AdminChannelSummary[];
  publications: AdminPublicationSummary[];
  credentials: AdminCredentialSummary[];
  recentActivity: AdminActivityEntry[];
  /**
   * Sum of `Asset.sizeBytes` beneath this user's videos, scoped by the
   * `videos/{videoId}/` storage-path prefix rather than by the `Asset.scene`
   * relation — see the query in `adminService.getUser` for why the obvious
   * join reports zero for everybody.
   */
  storageBytes: number;
  shorts: { total: number; byStatus: { status: ShortStatus; count: number }[] };
}

/**
 * The operational view the owner currently gets by asking for psql.
 *
 * Deployment-wide by definition: these are the numbers about the box, not
 * about a person, which is why they carry no `userId` and why nothing here is
 * reachable from a member's session.
 */
export interface AdminSystemTotals {
  userCount: number;
  operatorCount: number;
  pendingCount: number;
  rejectedCount: number;
  videosByStatus: { status: VideoStatus; count: number }[];
  videoCount: number;
  /** RenderJob rows a worker is holding or is about to pick up. */
  rendersInFlight: number;
  failedRenders: number;
  /** Videos whose lease has lapsed — a worker died holding them. */
  stalledVideos: number;
  failedShorts: number;
  channelCount: number;
  /** Sum of `Asset.sizeBytes` across the deployment. Null if nothing is stored. */
  storageBytes: number;
}
