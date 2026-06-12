import { describe, expect, it, vi } from "vitest";

import { finishPasskeyLogin, startPasskeyLogin } from "./webauthn";

describe("passkey WebAuthn ceremonies", () => {
  it("converts login challenge fields for native navigator.credentials and finishes with the credential response", async () => {
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

    const api = {
      POST: vi
        .fn()
        .mockResolvedValueOnce({
          data: {
            ceremony_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            challenge: {
              challenge: "AQID",
              allowCredentials: [{ id: "BAU", type: "public-key" }],
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
        }),
    };

    const ceremony = await startPasskeyLogin(
      api,
      "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    );
    const tokens = await finishPasskeyLogin(api, ceremony);

    expect(get).toHaveBeenCalledWith({
      publicKey: expect.objectContaining({
        challenge: Uint8Array.from([1, 2, 3]).buffer,
        allowCredentials: [
          expect.objectContaining({
            id: Uint8Array.from([4, 5]).buffer,
            type: "public-key",
          }),
        ],
      }),
    });
    expect(api.POST).toHaveBeenLastCalledWith(
      "/api/v1/auth/passkey/login/finish",
      {
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
      },
    );
    expect(tokens.access_token).toBe("access");
  });
});
