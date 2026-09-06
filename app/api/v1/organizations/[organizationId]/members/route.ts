import { withRoute } from '@/server/api/with-route';
import { tenantFromParam } from '@/server/api/tenant';
import { addMember, listMembers } from '@/server/services/memberships';
import {
  addMemberBodySchema,
  membersListQuerySchema,
  organizationIdParamSchema,
} from '@/lib/validation/resources';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const GET = withRoute({
  method: 'GET',
  auth: 'required',
  capability: 'membership:read',
  tenant: tenantFromParam('organizationId'),
  rateLimit: { class: 'read' },
  pageResult: true,
  summary: 'list organization members',
  paramSchema: organizationIdParamSchema,
  querySchema: membersListQuerySchema,
  handler: async ({ params, query }) =>
    listMembers({ organizationId: params.organizationId, query }),
});

const POST = withRoute({
  method: 'POST',
  auth: 'required',
  capability: 'organization:manage_members',
  tenant: tenantFromParam('organizationId'),
  rateLimit: { class: 'sensitive' },
  successStatus: 201,
  location: (data: { readonly id: string; readonly organizationId: string }) =>
    `/api/v1/organizations/${data.organizationId}/members/${data.id}`,
  summary: 'add an organization member',
  paramSchema: organizationIdParamSchema,
  bodySchema: addMemberBodySchema,
  handler: async ({ params, body }) =>
    addMember({
      organizationId: params.organizationId,
      userId: body.userId,
      role: body.role,
      jobTitle: body.jobTitle,
    }),
});

export { GET, POST };
