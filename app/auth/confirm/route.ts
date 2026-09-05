import {
  LINK_INVALID_PATH,
  LOGIN_PATH,
  RESET_PASSWORD_PATH,
  SET_PASSWORD_PATH,
  safeNextPath,
} from '@/lib/auth/routes';
import {
  exchangeInviteLink,
  exchangeRecoveryLink,
  isEmailLinkType,
} from '@/server/auth/email-links';

/**
 * GET /auth/confirm — the email-link callback (design §1, §2.2, §9).
 *
 * One route handler, self-guarding (the token exchange IS the authentication):
 * every invitation and recovery email lands here as
 * `/auth/confirm?type=…&token_hash=…&it=…&next=…`, and the tokens are consumed
 * SERVER-SIDE — no token ever reaches browser JS or a URL fragment (§13
 * control 2). Not built with `withRoute`: this endpoint answers with
 * redirects, not API envelopes, and is outside `app/api/**` by design (§15
 * taxonomy, "public route handler").
 *
 * SECURITY: tokens appear only in the URL of the email link; this handler
 * never logs the query string, and the redirect targets are constants plus a
 * SAME-ORIGIN-SANITISED `next` (open-redirect guard).
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const type = url.searchParams.get('type') ?? '';
  const tokenHash = url.searchParams.get('token_hash') ?? '';

  // Malformed or probing links get the neutral page, with no distinction
  // between "missing" and "wrong" (§12).
  if (!isEmailLinkType(type) || tokenHash.length === 0) {
    return redirectTo(LINK_INVALID_PATH);
  }

  // `next` is accepted only as a same-origin relative path.
  const fallback = type === 'invite' ? SET_PASSWORD_PATH : RESET_PASSWORD_PATH;
  const next = safeNextPath(url.searchParams.get('next'), fallback);

  if (type === 'invite') {
    const rawAppToken = url.searchParams.get('it') ?? '';
    if (rawAppToken.length === 0) {
      return redirectTo(LINK_INVALID_PATH);
    }

    const outcome = await exchangeInviteLink({ tokenHash, rawAppToken: rawAppToken, next });

    switch (outcome.result) {
      case 'accepted':
        // Fresh session on the redirect; the account is ACTIVE but has NO
        // password until /auth/set-password completes (§2.2 step 3).
        return redirectTo(SET_PASSWORD_PATH);
      case 'already-accepted':
        return redirectTo(`${LOGIN_PATH}?notice=already_accepted`);
      default:
        return redirectTo(
          outcome.reason === 'expired'
            ? `${LINK_INVALID_PATH}?reason=expired`
            : outcome.reason === 'revoked'
              ? `${LINK_INVALID_PATH}?reason=revoked`
              : LINK_INVALID_PATH,
        );
    }
  }

  // type === 'recovery'
  const outcome = await exchangeRecoveryLink({ tokenHash, next });

  if (outcome.result === 'verified') {
    // GoTrue recovery links sign the user in — mailbox control is the
    // credential (§9 step 2). Cookies ride the redirect.
    return redirectTo(RESET_PASSWORD_PATH);
  }

  return redirectTo(`${LINK_INVALID_PATH}?reason=recovery`);
}

function redirectTo(location: string): Response {
  // 303: the link click is a GET; the browser must follow with GET too, and
  // caches must not memorise a token-bearing URL.
  return new Response(null, {
    status: 303,
    headers: { Location: location, 'Cache-Control': 'no-store' },
  });
}
