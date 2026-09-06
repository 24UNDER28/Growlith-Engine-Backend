import { withRoute } from '@/server/api/with-route';
import {
  createComment,
  listComments,
  resolveCommentSubjectTenant,
} from '@/server/services/comments';
import { commentListQuerySchema, createCommentBodySchema } from '@/lib/validation/resources';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const GET = withRoute({
  method: 'GET',
  auth: 'required',
  capability: 'comment:read',
  tenant: ({ query }) => resolveCommentSubjectTenant(query),
  rateLimit: { class: 'read' },
  pageResult: true,
  summary: 'list comments on a subject',
  querySchema: commentListQuerySchema,
  handler: async ({ query }) => listComments({ query }),
});

const POST = withRoute({
  method: 'POST',
  auth: 'required',
  capability: 'comment:create',
  tenant: ({ body }) => resolveCommentSubjectTenant(body),
  rateLimit: { class: 'mutation' },
  idempotency: true,
  successStatus: 201,
  location: (data: { readonly id: string }) => `/api/v1/comments/${data.id}`,
  summary: 'create a comment',
  bodySchema: createCommentBodySchema,
  handler: async ({ body, auth, request, requestId }) =>
    createComment({ body, auth, request, requestId }),
});

export { GET, POST };
