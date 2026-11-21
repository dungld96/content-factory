// Session payload (ADR-0009): allow-listed fields only. No password, hash, email, role, IP or
// user agent. Roles are read from the database on every request.
import 'express-session';

declare module 'express-session' {
  interface SessionData {
    userId?: string;
    /** ISO timestamp of the login that created this session. */
    authenticatedAt?: string;
  }
}
