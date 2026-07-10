import Foundation

public enum PasskeyChallengeParsingError: Error, Equatable, Sendable, LocalizedError, CustomStringConvertible {
    case malformedJSON
    case missingChallenge
    case invalidBase64URLChallenge

    public var description: String {
        switch self {
        case .malformedJSON:
            "Malformed passkey challenge JSON"
        case .missingChallenge:
            "Missing passkey challenge"
        case .invalidBase64URLChallenge:
            "Invalid base64url passkey challenge"
        }
    }

    public var errorDescription: String? { description }
}

public enum PasskeyChallengeParser {
    public static func challengeData(from challengeJSON: String) throws -> Data {
        guard let data = challengeJSON.data(using: .utf8) else {
            throw PasskeyChallengeParsingError.malformedJSON
        }

        let decodedJSON: Any
        do {
            decodedJSON = try JSONSerialization.jsonObject(with: data)
        } catch {
            throw PasskeyChallengeParsingError.malformedJSON
        }

        guard
            let object = decodedJSON as? [String: Any],
            let challenge = challengeString(in: object)
        else {
            throw PasskeyChallengeParsingError.missingChallenge
        }

        guard let challengeData = Data(base64URLEncodedPasskeyChallenge: challenge) else {
            throw PasskeyChallengeParsingError.invalidBase64URLChallenge
        }
        return challengeData
    }

    private static func challengeString(in object: [String: Any]) -> String? {
        if let challenge = object["challenge"] as? String {
            return challenge
        }
        if let publicKey = object["publicKey"] as? [String: Any],
           let challenge = publicKey["challenge"] as? String {
            return challenge
        }
        return nil
    }
}

private extension Data {
    init?(base64URLEncodedPasskeyChallenge value: String) {
        guard !value.isEmpty else {
            return nil
        }

        var unpaddedValue = value
        if let paddingStart = value.firstIndex(of: "=") {
            let padding = value[paddingStart...]
            guard padding.allSatisfy({ $0 == "=" }), padding.count <= 2 else {
                return nil
            }
            unpaddedValue = String(value[..<paddingStart])
        }

        let alphabet = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_")
        guard
            !unpaddedValue.isEmpty,
            unpaddedValue.rangeOfCharacter(from: alphabet.inverted) == nil,
            unpaddedValue.count % 4 != 1
        else {
            return nil
        }

        var base64 = unpaddedValue
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        let padding = base64.count % 4
        if padding > 0 {
            base64 += String(repeating: "=", count: 4 - padding)
        }

        guard let decoded = Data(base64Encoded: base64) else {
            return nil
        }
        self = decoded
    }
}
