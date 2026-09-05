import 'server-only';

import { randomBytes, createHash } from 'node:crypto';

import { z } from 'zod';

import type { AuthContext } from '@/lib/auth/context';
import { optionalTextField, textField, uuidField } from '@/lib/validation/common';
import { ApiError } from '@/server/api/errors';
import { getClientEnv } from '@/lib/env/client-env';
import { createLogger, type Logger } from '@/server/logging/logger';
import { recordAuthEvent } from '@/server/auth/audit';
// JUSTIFIED service-role call sites (client-service.ts rule) — invitations are
// administration performed on ANOTHER identity before it exists as a principal:
//   - admin invite (GoTrue admin API) — creating the identity at all;
//   - app_metadata write — the non-authoritative routing hint, service-only;
//   - invitations/memberships writes — no policies exist yet (Phase 4), and
//     role assignment must be an explicit audited SERVER decision, never a
//     side effect of link-clicking (design §2.1 step 5).
import { getSupabaseServiceClient } from '@/server/supabase/client-service';
import { createSupabaseServerClient } from '@/server/supabase/client-server';
import type { Database } from '@/types/database';

/**
 * The invitation service (design §2): create, resend, revoke.
 *
 * Every account originates from a server-side invitation; sign-up is disabled.
 * The invitation is both an email and an audited database row whose token
 * exists ONLY in the email — the database stores `sha256(token)` (hex).
 *
 * The raw token is 32 bytes of CSPRNG, base64url: a credential with the same
 * lifetime as the invitation (7 days), single-purpose, expiring, revocable.
 */

export const invitationTtlDays = 7;

export const createInvitationBodySchema = z
  .object({
    email: z.email({ message: 'email must be a valid email address' }),
    fullName: textField('fullName', 200),
    // Exactly one branch, mirroring the `invitations_exactly_one_branch` CHECK.
    organizationId: uuidField('organizationId').optional(),
    organizationRole: z.enum(['CLIENT_ADMIN', 'CLIENT_MEMBER']).optional(),
    platformRole: z.enum(['SUPER_ADMIN', 'ADMIN']).optional(),
    message: optionalTextField('message', 1000),
  })
  .strict()
  .refine(
    (value) =>
      (value.organizationId !== undefined &&
        value.organizationRole !== undefined &&
        value.platformRole === undefined) ||
      (value.organizationId === undefined &&
        value.organizationRole === undefined &&
        value.platformRole !== undefined),
    {
      message:
        'Exactly one target is required: either (organizationId, organizationRole) for a client invitation, or platformRole for a staff invitation — never both, never neither.',
      path: ['organizationId'],
    },
  );

export type CreateInvitationBody = z.infer<typeof createInvitationBodySchema>;

export interface InvitationDto {
  readonly id: string;
  readonly email: string;
  readonly status: 'PENDING' | 'ACCEPTED' | 'EXPIRED' | 'REVOKED';
  readonly organizationId: string | null;
  readonly organizationRole: 'CLIENT_ADMIN' | 'CLIENT_MEMBER' | null;
  readonly platformRole: 'SUPER_ADMIN' | 'ADMIN' | null;
  readonly expiresAt: string;
  readonly resentCount: number;
  readonly lastSentAt: string;
}

type InvitationRow = Database['public']['Tables']['invitations']['Row'];

/* ─────────────────────────────── create ────────────────────────────────── */

export async function createInvitation(input: {
  readonly body: CreateInvitationBody;
  readonly auth: AuthContext;
  readonly request: Request;
  readonly requestId: string;
}): Promise<InvitationDto> {
  const log = createLogger({ scope: 'invitations', requestId: input.requestId });
  const service = getSupabaseServiceClient();
  const email = input.body.email.trim().toLowerCase();
  const isStaff = input.body.platformRole !== undefined;

  // Ceiling 1, §A — the invitation path is the membership path's twin door, so
  // it must carry the same lock: a CLIENT caller may only ever invite a
  // CLIENT_MEMBER. Elevating a client into CLIENT_ADMIN requires an internal
  // operator, exactly as in add_organization_member(); without this, the first
  // compromised client admin could mint themselves a second admin and own the
  // tenant permanently. The staff branch is unreachable for client callers
  // anyway (the route's tenant resolver yields no tenant → 403), but the check
  // guards the client branch regardless of how the service is reached.
  if (input.auth.platformRole === null && input.body.organizationRole === 'CLIENT_ADMIN') {
    throw ApiError.forbidden(
      'A CLIENT_ADMIN may only invite CLIENT_MEMBER members; a CLIENT_ADMIN invitation requires an internal operator.',
    );
  }

  // Resolve the target (§2.1 step 2). Three states, three actions.
  const existing = await findLiveProfileByEmail(email);

  if (existing !== null && existing.account_status !== 'INVITED') {
    // Confirmed, live profile: an existing person is routed through status and
    // role flows, never a second invitation.
    throw ApiError.conflict('This address already belongs to an existing account.');
  }

  // Client branch: the target organization must exist before anything is written.
  if (!isStaff) {
    const organizationId = input.body.organizationId as string;
    const { data: org, error: orgError } = await service
      .from('organizations')
      .select('id')
      .eq('id', organizationId)
      .is('deleted_at', null)
      .maybeSingle();

    if (orgError !== null) {
      throw ApiError.serviceUnavailable('The target organization could not be verified.');
    }
    if (org === null) {
      throw ApiError.notFound('The target organization does not exist.');
    }
  }

  const token = mintInvitationToken();
  const tokenHash = hashInvitationToken(token);
  const redirectTo = buildInviteRedirect(token);

  if (existing === null) {
    // No auth user → create + invite. GoTrue creates auth.users; the Phase 2
    // `on_auth_user_created` trigger creates the profiles row (INVITED).
    const userType = isStaff ? 'INTERNAL' : 'CLIENT';
    const { data: invited, error: inviteError } = await service.auth.admin.inviteUserByEmail(
      email,
      {
        data: { full_name: input.body.fullName, user_type: userType },
        redirectTo,
      },
    );

    if (inviteError !== null) {
      throw mapInviteError(inviteError);
    }

    const authUserId = invited.user.id;

    // The routing hint is written ONLY by the service role (§11 rule 2), and
    // carries exactly one application value: user_type.
    const { error: metadataError } = await service.auth.admin.updateUserById(authUserId, {
      app_metadata: { user_type: userType },
    });
    if (metadataError !== null) {
      // Non-fatal: the hint is advisory; the database is authoritative.
      log.warn('app_metadata routing hint could not be written', { reason: metadataError.message });
    }

    const row = await insertInvitationRow({
      body: input.body,
      email,
      tokenHash,
      invitedBy: input.auth.userId,
      targetUserId: authUserId,
    });

    await recordInvitationSent(input, row, authUserId, isStaff);
    return toDto(row);
  }

  // Auth user exists but is INVITED (invited, never accepted) → RE-ISSUE.
  return resendPendingInvitation({
    input,
    email,
    token,
    tokenHash,
    redirectTo,
    log,
  });
}

/* ─────────────────────────────── resend ────────────────────────────────── */

export async function resendInvitation(input: {
  readonly id: string;
  readonly auth: AuthContext;
  readonly request: Request;
  readonly requestId: string;
}): Promise<InvitationDto> {
  const log = createLogger({ scope: 'invitations', requestId: input.requestId });

  const row = await loadInvitation(input.id);
  if (row.status !== 'PENDING') {
    throw ApiError.conflict(
      `Only a PENDING invitation can be re-sent (current status: ${row.status}).`,
    );
  }
  if (Date.parse(row.expires_at) <= Date.now()) {
    throw ApiError.conflict('This invitation has expired. Create a new one.');
  }

  const token = mintInvitationToken();
  const tokenHash = hashInvitationToken(token);
  const redirectTo = buildInviteRedirect(token);

  return resendPendingInvitation({
    input: {
      // Re-send preserves the frozen terms (email, target, role) of the
      // existing row — organizationId/organizationRole/platformRole come from
      // the row, not from any caller input.
      body: {
        email: row.email,
        fullName: '',
        organizationId: row.organization_id ?? undefined,
        organizationRole: row.organization_role ?? undefined,
        platformRole: row.platform_role ?? undefined,
      },
      auth: input.auth,
      request: input.request,
      requestId: input.requestId,
    },
    email: row.email,
    token,
    tokenHash,
    redirectTo,
    log,
    existingRow: row,
  });
}

/**
 * Shared re-issue path (§2.1 step 2 row 2 and §2.3 resend): re-run the GoTrue
 * invite (a fresh mailbox token), rotate the app token on the same row —
 * permitted by the amended `freeze_invitation_terms` while PENDING — and bump
 * the resend counters.
 */
async function resendPendingInvitation(input: {
  readonly input: {
    readonly body: CreateInvitationBody;
    readonly auth: AuthContext;
    readonly request: Request;
    readonly requestId: string;
  };
  readonly email: string;
  readonly token: string;
  readonly tokenHash: string;
  readonly redirectTo: string;
  readonly log: Logger;
  readonly existingRow?: InvitationRow;
}): Promise<InvitationDto> {
  const service = getSupabaseServiceClient();
  const { log } = input;
  const isStaff = input.input.body.platformRole !== undefined;

  // The GoTrue invite is re-sent to the (still unconfirmed) address; the
  // userType hint and original full_name are already on the identity, so the
  // re-send carries no user_metadata that could overwrite them.
  const { error: inviteError } = await service.auth.admin.inviteUserByEmail(input.email, {
    redirectTo: input.redirectTo,
  });

  if (inviteError !== null) {
    throw mapInviteError(inviteError);
  }

  const expiresAt = new Date(Date.now() + invitationTtlDays * 24 * 60 * 60 * 1000).toISOString();

  let row: InvitationRow;
  if (input.existingRow !== undefined) {
    row = await updateForResend(input.existingRow, input.tokenHash, expiresAt);
  } else {
    const targetId = await findProfileIdByEmail(input.email);
    if (targetId === null) {
      // The re-issue path requires an existing INVITED profile; its absence is
      // an integrity failure, not a client error.
      throw ApiError.internal(new Error('re-issue target profile disappeared mid-flight'));
    }
    row = await insertInvitationRow({
      body: input.input.body,
      email: input.email,
      tokenHash: input.tokenHash,
      invitedBy: input.input.auth.userId,
      targetUserId: targetId,
    });
  }

  const targetId = await findProfileIdByEmail(input.email);
  await recordInvitationSent(input.input, row, targetId, isStaff);

  log.info('invitation re-issued', { invitationId: row.id });

  return toDto(row);
}

/* ─────────────────────────────── revoke ────────────────────────────────── */

/**
 * Phase 4 — the guard-side tenant resolver for by-id invitation routes
 * (§I.3 step 4: the tenant comes from the row, not from the caller). Read
 * through the CALLER's own client on purpose: the RLS policies define what
 * this identity can see, so an invitation of another tenant reads exactly as
 * a missing one, and the guard turns that into the shared 404. Never the
 * service client here — a guard that sees more than the caller does is how
 * existence leaks.
 */
export async function invitationOrganizationIdForGuard(id: string): Promise<string | null> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from('invitations')
    .select('organization_id')
    .eq('id', id)
    .maybeSingle();
  if (error !== null) {
    // Unreadable is not "not found": 503, so a database hiccup can never
    // masquerade as an absent invitation.
    throw ApiError.serviceUnavailable('The invitation could not be inspected.');
  }
  const raw = (data as { organization_id?: string | null } | null)?.organization_id;
  return typeof raw === 'string' ? raw : null;
}

export async function revokeInvitation(input: {
  readonly id: string;
  readonly reason?: string;
  readonly auth: AuthContext;
  readonly request: Request;
  readonly requestId: string;
}): Promise<InvitationDto> {
  const log = createLogger({ scope: 'invitations', requestId: input.requestId });
  const service = getSupabaseServiceClient();

  const row = await loadInvitation(input.id);
  if (row.status !== 'PENDING') {
    throw ApiError.conflict(
      `Only a PENDING invitation can be revoked (current status: ${row.status}).`,
    );
  }

  // A revoked invitation does NOT touch the GoTrue identity: an unconfirmed
  // identity that was never accepted is inert (no password, no session), and
  // an accepted invitation is terminal — offboarding goes through account
  // statuses, not here (§2.3).
  const { data: updated, error } = await service
    .from('invitations')
    .update({
      status: 'REVOKED',
      revoked_at: new Date().toISOString(),
      revoked_by: input.auth.userId,
    })
    .eq('id', input.id)
    .eq('status', 'PENDING')
    .select('*')
    .single();

  if (error !== null || updated === null) {
    throw ApiError.conflict(
      'The invitation changed while the request was in flight; reload and retry.',
    );
  }

  await recordAuthEvent({
    action: 'STATUS_CHANGE',
    severity: 'NOTICE',
    entityId: updated.accepted_user_id ?? (await findProfileIdByEmail(updated.email)) ?? updated.id,
    actorUserId: input.auth.userId,
    actorRole: input.auth.platformRole ?? undefined,
    organizationId: updated.organization_id ?? undefined,
    requestId: input.requestId,
    request: input.request,
    changedFields: ['status'],
    before: { status: 'PENDING' },
    after: { status: 'REVOKED' },
    reason: input.reason ?? 'invitation revoked',
  });

  log.info('invitation revoked', { invitationId: input.id });

  return toDto(updated);
}

/* ─────────────────────────────── internals ─────────────────────────────── */

function mintInvitationToken(): string {
  return randomBytes(32).toString('base64url');
}

function hashInvitationToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function buildInviteRedirect(rawToken: string): string {
  const { NEXT_PUBLIC_APP_URL: appUrl } = getClientEnv();
  // GoTrue appends `token_hash=…&type=invite` to the redirect target; `it`
  // selects OUR invitation. Both credentials, one link, server-consumed.
  return `${appUrl}/auth/confirm?type=invite&it=${encodeURIComponent(rawToken)}`;
}

async function insertInvitationRow(input: {
  readonly body: CreateInvitationBody;
  readonly email: string;
  readonly tokenHash: string;
  readonly invitedBy: string;
  /** The GoTrue identity's id (the trigger guarantees a profile row exists). */
  readonly targetUserId: string;
}): Promise<InvitationRow> {
  const service = getSupabaseServiceClient();
  const { body } = input;
  const expiresAt = new Date(Date.now() + invitationTtlDays * 24 * 60 * 60 * 1000).toISOString();

  const insert: Database['public']['Tables']['invitations']['Insert'] = {
    email: input.email,
    organization_id: body.organizationId ?? null,
    organization_role: body.organizationRole ?? null,
    platform_role: body.platformRole ?? null,
    invited_by: input.invitedBy,
    token_hash: input.tokenHash,
    status: 'PENDING',
    expires_at: expiresAt,
    message: body.message ?? null,
  };

  const { data, error } = await service.from('invitations').insert(insert).select('*').single();

  if (error !== null) {
    if (error.code === '23505') {
      // invitations_pending_unique: two live invitations for the same address
      // into the same target are unrepresentable — the conflict path IS the
      // concurrency path (§2.1 step 2).
      throw ApiError.conflict('A pending invitation already exists for this address and target.');
    }
    throw ApiError.internal(error);
  }

  // Client branch: the INVITED membership row is written HERE, at invite time,
  // so role assignment is an explicit audited server decision rather than a
  // side effect of link-clicking (§2.1 step 5).
  if (body.organizationId !== undefined && body.organizationRole !== undefined) {
    const { error: membershipError } = await service.from('organization_memberships').insert({
      organization_id: body.organizationId,
      user_id: input.targetUserId,
      role: body.organizationRole,
      status: 'INVITED',
      invited_by: input.invitedBy,
    });

    if (membershipError !== null) {
      // The invitation ledger row exists but the membership write failed:
      // surface it — acceptance would then hit MEMBERSHIP_MISSING, and the
      // operator should see the real cause now, not the invitee later.
      throw ApiError.internal(membershipError);
    }
  }

  return data;
}

async function updateForResend(
  row: InvitationRow,
  tokenHash: string,
  expiresAt: string,
): Promise<InvitationRow> {
  const service = getSupabaseServiceClient();

  // resent_count is computed from the row just loaded, and the update is
  // guarded on status='PENDING', so two racing resends cannot double-apply.
  const { data, error } = await service
    .from('invitations')
    .update({
      token_hash: tokenHash,
      expires_at: expiresAt,
      resent_count: row.resent_count + 1,
      last_sent_at: new Date().toISOString(),
    })
    .eq('id', row.id)
    .eq('status', 'PENDING')
    .select('*')
    .single();

  if (error !== null || data === null) {
    throw ApiError.conflict(
      'The invitation changed while the request was in flight; reload and retry.',
    );
  }

  return data;
}

async function loadInvitation(id: string): Promise<InvitationRow> {
  const service = getSupabaseServiceClient();
  const { data, error } = await service.from('invitations').select('*').eq('id', id).maybeSingle();

  if (error !== null) {
    throw ApiError.serviceUnavailable('The invitation could not be loaded.');
  }
  if (data === null) {
    throw ApiError.notFound('No such invitation.');
  }
  return data;
}

async function findLiveProfileByEmail(email: string): Promise<{
  id: string;
  account_status: 'INVITED' | 'ACTIVE' | 'SUSPENDED' | 'DEACTIVATED';
  deleted_at: string | null;
} | null> {
  const { data, error } = await getSupabaseServiceClient()
    .from('profiles')
    .select('id, account_status, deleted_at')
    .eq('email', email)
    .maybeSingle();

  if (error !== null) {
    throw ApiError.serviceUnavailable('The existing-account check could not be performed.');
  }
  if (data === null || data.deleted_at !== null) {
    return null;
  }
  return data;
}

async function findProfileIdByEmail(email: string): Promise<string | null> {
  const { data } = await getSupabaseServiceClient()
    .from('profiles')
    .select('id')
    .eq('email', email)
    .maybeSingle();
  return data?.id ?? null;
}

async function recordInvitationSent(
  input: { readonly auth: AuthContext; readonly request: Request; readonly requestId: string },
  row: InvitationRow,
  targetProfileId: string | null,
  isStaff: boolean,
): Promise<void> {
  await recordAuthEvent({
    action: 'INVITE_SENT',
    // CRITICAL for the staff branch: a platform-role grant is in flight.
    severity: isStaff ? 'CRITICAL' : 'NOTICE',
    entityId: targetProfileId ?? row.invited_by,
    actorUserId: input.auth.userId,
    actorRole: input.auth.platformRole ?? undefined,
    organizationId: row.organization_id ?? undefined,
    requestId: input.requestId,
    request: input.request,
    after: {
      invitationId: row.id,
      email: row.email,
      organizationRole: row.organization_role,
      platformRole: row.platform_role,
      expiresAt: row.expires_at,
    },
    reason: 'invitation email sent',
  });
}

function mapInviteError(error: {
  readonly message: string;
  readonly status?: number | undefined;
}): ApiError {
  if (/already registered/i.test(error.message)) {
    // A live profile row should have caught this; the race is real, the answer
    // is the same 409.
    return ApiError.conflict('This address already belongs to an existing account.');
  }
  if (typeof error.status === 'number' && error.status >= 500) {
    return ApiError.serviceUnavailable('The invitation email could not be sent.');
  }
  if (typeof error.status === 'number' && error.status === 429) {
    return ApiError.tooManyRequests('The invitation email rate limit was hit. Retry later.');
  }
  return ApiError.badRequest('The invitation could not be created.', error);
}

function toDto(row: InvitationRow): InvitationDto {
  return {
    id: row.id,
    email: row.email,
    status: row.status,
    organizationId: row.organization_id,
    organizationRole: row.organization_role,
    platformRole: row.platform_role,
    expiresAt: row.expires_at,
    resentCount: row.resent_count,
    lastSentAt: row.last_sent_at,
  };
}
