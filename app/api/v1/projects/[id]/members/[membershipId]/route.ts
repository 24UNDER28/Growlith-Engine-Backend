import { withRoute } from '@/server/api/with-route';
import { tenantFromRow } from '@/server/api/tenant';
import { patchProjectMember, removeProjectMember } from '@/server/services/projects';
import { patchProjectMemberBodySchema, projectMemberParamSchema } from '@/lib/validation/resources';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const PATCH = withRoute({
  method: 'PATCH',
  auth: 'required',
  capability: 'project:manage_members',
  tenant: tenantFromRow('projects', 'id'),
  project: ({ params }) => params.id,
  rateLimit: { class: 'mutation' },
  summary: 'update a project membership',
  paramSchema: projectMemberParamSchema,
  bodySchema: patchProjectMemberBodySchema,
  handler: async ({ params, body, auth, request, requestId }) =>
    patchProjectMember({
      auth,
      request,
      requestId,
      projectId: params.id,
      membershipId: params.membershipId,
      projectRole: body.projectRole,
      allocationPct: body.allocationPct,
    }),
});

const DELETE = withRoute({
  method: 'DELETE',
  auth: 'required',
  capability: 'project:manage_members',
  tenant: tenantFromRow('projects', 'id'),
  project: ({ params }) => params.id,
  rateLimit: { class: 'mutation' },
  successStatus: 204,
  summary: 'remove a project member',
  paramSchema: projectMemberParamSchema,
  handler: async ({ params, auth, request, requestId }) => {
    await removeProjectMember({
      auth,
      request,
      requestId,
      projectId: params.id,
      membershipId: params.membershipId,
    });
  },
});

export { PATCH, DELETE };
