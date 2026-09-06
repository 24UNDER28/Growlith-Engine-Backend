import { z } from 'zod';
import { withRoute } from '@/server/api/with-route';
import { uuidField } from '@/lib/validation/common';
import { invitationOrganizationIdForGuard } from '@/server/auth/invitations';
import { getInvitation } from '@/server/services/invitations-query';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const GET = withRoute({
  method: 'GET',
  auth: 'required',
  capability: 'invitation:read',
  tenant: ({ params }) => invitationOrganizationIdForGuard(params.id),
  rateLimit: { class: 'read' },
  summary: 'read one invitation',
  paramSchema: z.object({ id: uuidField('id') }).strict(),
  handler: async ({ params }) => getInvitation(params.id),
});

export { GET };
