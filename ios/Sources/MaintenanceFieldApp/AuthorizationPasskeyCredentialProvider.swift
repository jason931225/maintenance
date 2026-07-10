import AuthenticationServices
import Foundation
import MaintenanceAPIClient
import MaintenanceFieldCore

#if os(iOS)
import UIKit
#elseif os(macOS)
import AppKit
#endif

final class AuthorizationPasskeyCredentialProvider: NSObject, PasskeyCredentialProvider, @unchecked Sendable {
    private let relyingPartyIdentifier: String
    private var continuation: CheckedContinuation<Components.Schemas.PasskeyLoginFinishRequest.CredentialPayload, Error>?
    private var activeController: ASAuthorizationController?

    init(relyingPartyIdentifier: String) {
        self.relyingPartyIdentifier = relyingPartyIdentifier
    }

    @MainActor
    func credentialAssertion(
        challengeJSON: String
    ) async throws -> Components.Schemas.PasskeyLoginFinishRequest.CredentialPayload {
        let challenge = try PasskeyChallengeParser.challengeData(from: challengeJSON)
        let platformProvider = ASAuthorizationPlatformPublicKeyCredentialProvider(
            relyingPartyIdentifier: relyingPartyIdentifier
        )
        let securityKeyProvider = ASAuthorizationSecurityKeyPublicKeyCredentialProvider(
            relyingPartyIdentifier: relyingPartyIdentifier
        )
        let requests: [ASAuthorizationRequest] = [
            platformProvider.createCredentialAssertionRequest(challenge: challenge),
            securityKeyProvider.createCredentialAssertionRequest(challenge: challenge),
        ]

        return try await withCheckedThrowingContinuation { continuation in
            self.continuation = continuation
            let controller = ASAuthorizationController(authorizationRequests: requests)
            controller.delegate = self
            controller.presentationContextProvider = self
            activeController = controller
            controller.performRequests()
        }
    }

    private func finish(with result: Result<Components.Schemas.PasskeyLoginFinishRequest.CredentialPayload, Error>) {
        let continuation = continuation
        self.continuation = nil
        activeController = nil
        switch result {
        case let .success(payload):
            continuation?.resume(returning: payload)
        case let .failure(error):
            continuation?.resume(throwing: error)
        }
    }
}

extension AuthorizationPasskeyCredentialProvider: ASAuthorizationControllerDelegate {
    func authorizationController(
        controller: ASAuthorizationController,
        didCompleteWithAuthorization authorization: ASAuthorization
    ) {
        guard let assertion = authorization.credential as? any ASAuthorizationPublicKeyCredentialAssertion else {
            finish(with: .failure(PasskeyBridgeError.unsupportedCredential))
            return
        }

        do {
            let credential = PublicKeyCredentialAssertionPayload(
                id: assertion.credentialID.base64URLEncodedStringWithoutPadding(),
                rawId: assertion.credentialID.base64URLEncodedStringWithoutPadding(),
                type: "public-key",
                response: PublicKeyCredentialAssertionPayload.ResponsePayload(
                    authenticatorData: assertion.rawAuthenticatorData.base64URLEncodedStringWithoutPadding(),
                    clientDataJSON: assertion.rawClientDataJSON.base64URLEncodedStringWithoutPadding(),
                    signature: assertion.signature.base64URLEncodedStringWithoutPadding(),
                    userHandle: assertion.userID.base64URLEncodedStringWithoutPadding()
                ),
                clientExtensionResults: [:]
            )
            let data = try JSONEncoder().encode(credential)
            let payload = try JSONDecoder().decode(
                Components.Schemas.PasskeyLoginFinishRequest.CredentialPayload.self,
                from: data
            )
            finish(with: .success(payload))
        } catch {
            finish(with: .failure(error))
        }
    }

    func authorizationController(controller: ASAuthorizationController, didCompleteWithError error: any Error) {
        finish(with: .failure(error))
    }
}

extension AuthorizationPasskeyCredentialProvider: ASAuthorizationControllerPresentationContextProviding {
    func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
        #if os(iOS)
        return UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap(\.windows)
            .first { $0.isKeyWindow } ?? UIWindow()
        #elseif os(macOS)
        return NSApplication.shared.keyWindow ?? NSWindow()
        #else
        return ASPresentationAnchor()
        #endif
    }
}

private struct PublicKeyCredentialAssertionPayload: Encodable {
    struct ResponsePayload: Encodable {
        var authenticatorData: String
        var clientDataJSON: String
        var signature: String
        var userHandle: String
    }

    var id: String
    var rawId: String
    var type: String
    var response: ResponsePayload
    var clientExtensionResults: [String: String]
}

private enum PasskeyBridgeError: Error {
    case unsupportedCredential
}

private extension Data {
    func base64URLEncodedStringWithoutPadding() -> String {
        base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}
