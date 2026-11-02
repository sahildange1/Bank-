/**
 * Attached to the request by SessionAuthGuard once a session is validated.
 * This is the ONLY source of truth for "who is calling and which org do
 * they belong to" — organizationId here comes from the session's user row,
 * never from anything the client supplied in the URL/body/query.
 */
export interface AuthContext {
  userId: string;
  organizationId: string;
  sessionId: string;
  permissions: string[];
}

declare module 'express' {
  interface Request {
    authContext?: AuthContext;
  }
}
