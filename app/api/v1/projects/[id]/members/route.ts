import { withRoute } from '@/server/api/with-route';
import { tenantFromRow } from '@/server/api/tenant';
import { addProjectMember, listProjectMembers } from '@/server/services/projects';
import { createProjectMemberBodySchema, idParamSchema } from '@/lib/validation/resources';
import { paginationQuerySchema } from '@/lib/validation/pagination';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const GET = withRoute({
  method: 'GET',
  auth: 'required',
  capability: 'project_membership:read',
  tenant: tenantFromRow('projects', 'id'),
  rateLimit: { class: 'read' },
  pageResult: true,
  summary: 'list project members',
  paramSchema: idParamSchema,
  querySchema: paginationQuerySchema,
  handler: async ({ params, query, auth }) =>
    listProjectMembers({ auth, projectId: params.id, query }),
});

const POST = withRoute({
  method: 'POST',
  auth: 'required',
  capability: 'project:manage_members',
  tenant: tenantFromRow('projects', 'id'),
  project: ({ params }) => params.id,
  rateLimit: { class: 'mutation' },
  successStatus: 201,
  location: (data: { readonly id: string; readonly projectId: string }) =>
    `/api/v1/projects/${data.projectId}/members/${data.id}`,
  summary: 'add a project member',
  paramSchema: idParamSchema,
  bodySchema: createProjectMemberBodySchema,
  handler: async ({ params, body, auth, request, requestId }) =>
    addProjectMember({
      auth,
      request,
      requestId,
      projectId: params.id,
      userId: body.userId,
      projectRole: body.projectRole,
      allocationPct: body.allocationPct,
    }),
});

export { GET, POST };
