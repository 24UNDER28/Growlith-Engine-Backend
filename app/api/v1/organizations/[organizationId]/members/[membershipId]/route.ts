import { withRoute } from '@/server/api/with-route';
import { tenantFromParam } from '@/server/api/tenant';
import { patchMember, removeMember } from '@/server/services/memberships';
import {
  deleteMemberBodySchema,
  deleteMemberQuerySchema,
  membershipIdParamSchema,
  patchMemberBodySchema,
} from '@/lib/validation/resources';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const PATCH = withRoute({
  method: 'PATCH',
  auth: 'required',
  capability: 'organization:manage_members',
  tenant: tenantFromParam('organizationId'),
  rateLimit: { class: 'sensitive' },
  summary: 'update an organization membership',
  paramSchema: membershipIdParamSchema,
  bodySchema: patchMemberBodySchema,
  handler: async ({ params, body }) =>
    patchMember({
      organizationId: params.organizationId,
      membershipId: params.membershipId,
      role: body.role,
      status: body.status,
      isPrimaryContact: body.isPrimaryContact,
      newPrimaryMembershipId: body.newPrimaryMembershipId,
      jobTitle: body.jobTitle,
    }),
});

const DELETE = withRoute({
  method: 'DELETE',
  auth: 'required',
  capability: 'organization:manage_members',
  tenant: tenantFromParam('organizationId'),
  rateLimit: { class: 'sensitive' },
  successStatus: 204,
  summary: 'remove an organization member',
  paramSchema: membershipIdParamSchema,
  querySchema: deleteMemberQuerySchema,
  bodySchema: deleteMemberBodySchema,
  handler: async ({ params, query, body }) => {
    await removeMember({
      organizationId: params.organizationId,
      membershipId: params.membershipId,
      newPrimaryMembershipId: query.newPrimaryMembershipId,
      reason: body.reason,
    });
  },
});

export { PATCH, DELETE };
