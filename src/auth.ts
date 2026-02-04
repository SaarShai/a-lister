import { createRemoteJWKSet, jwtVerify } from "jose";
import type { IncomingMessage } from "node:http";

export type AuthContext = {
  authProviderId: string;
  handle: string;
  displayName?: string | null;
  avatarUrl?: string | null;
};

export class AuthError extends Error {
  status: number;
  constructor(message: string, status = 401) {
    super(message);
    this.status = status;
  }
}

function slugifyHandle(value: string): string {
  const base = value
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "")
    .replace(/_{2,}/g, "_")
    .replace(/^_+|_+$/g, "");
  return base || "user";
}

function pickHandle(payload: Record<string, unknown>): string {
  const raw =
    (payload.preferred_username as string | undefined) ||
    (payload.nickname as string | undefined) ||
    (payload.email as string | undefined) ||
    (payload.name as string | undefined) ||
    "user";
  return slugifyHandle(raw.split("@")[0]);
}

function parseBearerToken(req: IncomingMessage): string | null {
  const header = req.headers["authorization"];
  if (!header) return null;
  const value = Array.isArray(header) ? header[0] : header;
  const [type, token] = value.split(" ");
  if (type?.toLowerCase() !== "bearer" || !token) return null;
  return token.trim();
}

export async function getAuthContext(req: IncomingMessage): Promise<AuthContext> {
  const mode = process.env.AUTH_MODE ?? "dev";
  if (mode !== "oauth") {
    const handle =
      (req.headers["x-user-handle"] as string | undefined) ||
      process.env.DEV_USER_HANDLE ||
      "alister";
    const authProviderId =
      (req.headers["x-user-id"] as string | undefined) ||
      process.env.DEV_USER_ID ||
      `dev-${handle}`;
    return {
      authProviderId,
      handle: slugifyHandle(handle),
      displayName: handle,
    };
  }

  const token = parseBearerToken(req);
  if (!token) {
    throw new AuthError("Missing bearer token", 401);
  }

  const jwksUrl = process.env.AUTH_JWKS_URL;
  if (!jwksUrl) {
    throw new AuthError("AUTH_JWKS_URL not configured", 500);
  }

  const jwks = createRemoteJWKSet(new URL(jwksUrl));
  const issuer = process.env.AUTH_ISSUER;
  const audience = process.env.AUTH_AUDIENCE;

  const { payload } = await jwtVerify(token, jwks, {
    issuer: issuer || undefined,
    audience: audience || undefined,
  });

  if (!payload.sub) {
    throw new AuthError("Token missing subject", 401);
  }

  return {
    authProviderId: payload.sub,
    handle: pickHandle(payload),
    displayName: (payload.name as string | undefined) || null,
    avatarUrl: (payload.picture as string | undefined) || null,
  };
}

export function buildProtectedResourceMetadata() {
  const resourceUrl = process.env.BASE_URL || "";
  const authServer = process.env.AUTH_ISSUER || "";
  return {
    resource: resourceUrl,
    authorization_servers: authServer ? [authServer] : [],
    scopes_supported: ["openid", "profile"],
  };
}
