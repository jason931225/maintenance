import { describe, expect, it, vi } from "vitest";

import {
  OtpRedeemError,
  finishPasskeyLogin,
  issueAdminOtp,
  redeemOtp,
  startPasskeyLogin,
} from "./webauthn";

describe("passkey WebAuthn ceremonies", () => {
  it("starts a usernameless login with no request body and finishes with the credential response", async () => {
    class FakeAuthenticatorAssertionResponse {
      authenticatorData: ArrayBuffer;
      clientDataJSON: ArrayBuffer;
      signature: ArrayBuffer;
      userHandle: ArrayBuffer;

      constructor() {
        this.authenticatorData = Uint8Array.from([4, 5]).buffer;
        this.clientDataJSON = Uint8Array.from([6, 7]).buffer;
        this.signature = Uint8Array.from([8, 9]).buffer;
        this.userHandle = Uint8Array.from([10]).buffer;
      }
    }
    class FakePublicKeyCredential {
      id = "credential-1";
      type = "public-key";
      rawId = Uint8Array.from([1, 2, 3]).buffer;
      response = new FakeAuthenticatorAssertionResponse();
    }
    vi.stubGlobal("PublicKeyCredential", FakePublicKeyCredential);
    vi.stubGlobal(
      "AuthenticatorAssertionResponse",
      FakeAuthenticatorAssertionResponse,
    );
    vi.stubGlobal("AuthenticatorAttestationResponse", class {});

    const get = vi.fn().mockResolvedValue(new FakePublicKeyCredential());
    const create = vi.fn();
    vi.stubGlobal("navigator", { credentials: { create, get } });

    const post = vi
      .fn()
      .mockResolvedValueOnce({
        data: {
          ceremony_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          challenge: {
            challenge: "AQID",
            // Discoverable login: the backend returns an empty allowCredentials
            // so the browser shows its native passkey picker.
            allowCredentials: [],
            timeout: 60000,
            userVerification: "preferred",
          },
          expires_at: "2026-06-12T12:00:00Z",
        },
      })
      .mockResolvedValueOnce({
        data: {
          access_token: "access",
          refresh_token: "refresh",
          token_type: "Bearer",
          refresh_expires_at: "2026-06-19T12:00:00Z",
        },
      });
    const api = { POST: post };

    const ceremony = await startPasskeyLogin(api);
    const tokens = await finishPasskeyLogin(api, ceremony);

    // login/start is called with no user_id (empty options object).
    expect(post).toHaveBeenNthCalledWith(
      1,
      "/api/v1/auth/passkey/login/start",
      {},
    );
    expect(get).toHaveBeenCalledWith({
      publicKey: expect.objectContaining({
        challenge: Uint8Array.from([1, 2, 3]).buffer,
        allowCredentials: [],
      }),
    });
    expect(post).toHaveBeenLastCalledWith("/api/v1/auth/passkey/login/finish", {
      body: {
        ceremony_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        credential: expect.objectContaining({
          id: "credential-1",
          rawId: "AQID",
          response: expect.objectContaining({
            authenticatorData: "BAU",
            clientDataJSON: "Bgc",
            signature: "CAk",
            userHandle: "Cg",
          }),
          type: "public-key",
        }),
      },
    });
    expect(tokens.access_token).toBe("access");
  });
});

describe("redeemOtp", () => {
  it("redeems a one-time code and returns the session plus passkey-setup flag", async () => {
    const post = vi.fn().mockResolvedValue({
      data: {
        access_token: "a",
        refresh_token: "r",
        token_type: "Bearer",
        refresh_expires_at: "2026-06-19T12:00:00Z",
        requires_passkey_setup: true,
      },
      response: { status: 200 },
    });
    const api = { POST: post };

    const result = await redeemOtp(api, "  ABCD1234  ");

    expect(post).toHaveBeenCalledWith("/api/v1/auth/otp/redeem", {
      body: { otp: "ABCD1234" },
    });
    expect(result.requires_passkey_setup).toBe(true);
    expect(result.access_token).toBe("a");
  });

  it("throws an OtpRedeemError carrying the HTTP status on failure", async () => {
    const post = vi.fn().mockResolvedValue({
      data: undefined,
      response: { status: 429 },
    });
    const api = { POST: post };

    await expect(redeemOtp(api, "nope")).rejects.toMatchObject({
      name: "OtpRedeemError",
      status: 429,
    });
    await expect(redeemOtp(api, "nope")).rejects.toBeInstanceOf(OtpRedeemError);
  });
});

describe("issueAdminOtp", () => {
  it("posts the user and branch and returns the issued code", async () => {
    const post = vi.fn().mockResolvedValue({
      data: {
        user_id: "00000000-0000-4000-8000-000000000002",
        otp: "ABCD1234",
        expires_at: "2026-06-14T00:00:00Z",
      },
    });
    const api = { POST: post };

    const result = await issueAdminOtp(api, {
      user_id: "00000000-0000-4000-8000-000000000002",
      branch_id: "11111111-1111-4111-8111-111111111111",
    });

    expect(post).toHaveBeenCalledWith("/api/v1/auth/admin/otp/issue", {
      body: {
        user_id: "00000000-0000-4000-8000-000000000002",
        branch_id: "11111111-1111-4111-8111-111111111111",
      },
    });
    expect(result.otp).toBe("ABCD1234");
  });
});
