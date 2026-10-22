import type * as jose from "jose";
import { jwtVerify } from "jose";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveCloudflareAccessContext } from "./cloudflareAccess";
import { resolveSharedWorkspaceContext } from "./delegated";

vi.mock("cloudflare:workers", () => ({
  env: {
    TEAM_DOMAIN: "https://altys.cloudflareaccess.com",
    POLICY_AUD: "aud",
    ACCESS_SERVICE_TOKEN_CLIENT_ID: "allowed.access",
  },
}));
vi.mock("jose", async (importOriginal) => ({
  ...(await importOriginal<typeof jose>()),
  jwtVerify: vi.fn(),
}));
vi.mock("./delegated", () => ({ resolveSharedWorkspaceContext: vi.fn() }));

const headers = new Headers({ "cf-access-jwt-assertion": "token" });

function verifiedPayload(payload: Record<string, unknown>) {
  vi.mocked(jwtVerify).mockResolvedValue({
    payload,
    protectedHeader: { alg: "RS256" },
    key: new Uint8Array(),
  });
}

describe("resolveCloudflareAccessContext service tokens", () => {
  beforeEach(() => {
    vi.mocked(resolveSharedWorkspaceContext).mockResolvedValue({
      userId: "id",
      userEmail: "email",
      emailVerified: true,
      organizationId: "org",
      role: "owner",
    });
  });

  it("admits the configured service token as a fixed user", async () => {
    verifiedPayload({ sub: "", common_name: "allowed.access" });

    await resolveCloudflareAccessContext(headers);

    expect(resolveSharedWorkspaceContext).toHaveBeenCalledWith(
      "access-service-token:allowed.access",
      "allowed.access@service-token.invalid",
    );
  });

  it("keeps admitting people by their Access identity", async () => {
    verifiedPayload({ sub: "user-1", email: "person@altys.app" });

    await resolveCloudflareAccessContext(headers);

    expect(resolveSharedWorkspaceContext).toHaveBeenCalledWith(
      "user-1",
      "person@altys.app",
    );
  });

  it("rejects any other service token", async () => {
    verifiedPayload({ sub: "", common_name: "other.access" });

    await expect(resolveCloudflareAccessContext(headers)).rejects.toMatchObject(
      { code: "UNAUTHENTICATED" },
    );
    expect(resolveSharedWorkspaceContext).not.toHaveBeenCalled();
  });
});
