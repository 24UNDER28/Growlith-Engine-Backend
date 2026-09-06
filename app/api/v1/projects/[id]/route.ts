import { withRoute } from '@/server/api/with-route';
import { tenantFromRow } from '@/server/api/tenant';
import { deleteProject, getProject, patchProject } from '@/server/services/projects';
import { idParamSchema, patchProjectBodySchema } from '@/lib/validation/resources';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const GET = withRoute({
  method: 'GET',
  auth: 'required',
  capability: 'project:read',
  tenant: tenantFromRow('projects', 'id'),
  rateLimit: { class: 'read' },
  summary: 'read one project',
  paramSchema: idParamSchema,
  handler: async ({ params }) => getProject(params.id),
});

const PATCH = withRoute({
  method: 'PATCH',
  auth: 'required',
  capability: 'project:update',
  tenant: tenantFromRow('projects', 'id'),
  rateLimit: { class: 'mutation' },
  summary: 'update a project',
  paramSchema: idParamSchema,
  bodySchema: patchProjectBodySchema,
  handler: async ({ params, body, auth, request, requestId }) =>
    patchProject({ id: params.id, body, auth, request, requestId }),
});

const DELETE = withRoute({
  method: 'DELETE',
  auth: 'required',
  capability: 'project:delete',
  tenant: tenantFromRow('projects', 'id'),
  rateLimit: { class: 'mutation' },
  successStatus: 204,
  summary: 'soft-delete a project',
  paramSchema: idParamSchema,
  handler: async ({ params, auth, request, requestId }) => {
    await deleteProject({ id: params.id, auth, request, requestId });
  },
});

export { GET, PATCH, DELETE };
