import { withRoute } from '@/server/api/with-route';
import { tenantFromRow } from '@/server/api/tenant';
import { commentAuthorForGuard, deleteComment, getComment, patchComment } from '@/server/services/comments';
import { idParamSchema, patchCommentBodySchema } from '@/lib/validation/resources';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const GET = withRoute({
  method: 'GET',
  auth: 'required',
  capability: 'comment:read',
  tenant: tenantFromRow('comments', 'id'),
  rateLimit: { class: 'read' },
  summary: 'read one comment',
  paramSchema: idParamSchema,
  handler: async ({ params }) => getComment(params.id),
});

const PATCH = withRoute({
  method: 'PATCH',
  auth: 'required',
  capability: 'comment:update',
  tenant: tenantFromRow('comments', 'id'),
  subjectUser: ({ params }) => commentAuthorForGuard(params.id),
  rateLimit: { class: 'mutation' },
  summary: 'edit a comment',
  paramSchema: idParamSchema,
  bodySchema: patchCommentBodySchema,
  handler: async ({ params, body, auth, request, requestId }) =>
    patchComment({ id: params.id, body: body.body, auth, request, requestId }),
});

const DELETE = withRoute({
  method: 'DELETE',
  auth: 'required',
  capability: 'comment:delete',
  tenant: tenantFromRow('comments', 'id'),
  subjectUser: ({ params }) => commentAuthorForGuard(params.id),
  rateLimit: { class: 'mutation' },
  successStatus: 204,
  summary: 'soft-delete a comment',
  paramSchema: idParamSchema,
  handler: async ({ params, auth, request, requestId }) => {
    await deleteComment({ id: params.id, auth, request, requestId });
  },
});

export { GET, PATCH, DELETE };
