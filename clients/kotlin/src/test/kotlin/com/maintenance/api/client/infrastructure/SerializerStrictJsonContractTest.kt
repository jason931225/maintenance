package com.maintenance.api.client.infrastructure

import com.maintenance.api.client.model.TokenPairResponse
import io.kotlintest.shouldBe
import io.kotlintest.shouldThrow
import io.kotlintest.specs.StringSpec
import kotlinx.serialization.SerializationException
import kotlinx.serialization.decodeFromString

class SerializerStrictJsonContractTest : StringSpec({
    "generated-client JSON accepts the matching contract fixture" {
        val decoded = Serializer.kotlinxSerializationJson.decodeFromString<TokenPairResponse>(
            contractDriftFixture("token-pair-response-valid.json")
        )

        decoded.accessToken shouldBe "access-123"
        decoded.tokenType shouldBe TokenPairResponse.TokenType.BEARER
    }

    "generated-client JSON rejects unknown response keys" {
        shouldThrow<SerializationException> {
            Serializer.kotlinxSerializationJson.decodeFromString<TokenPairResponse>(
                contractDriftFixture("token-pair-response-unknown-key.json")
            )
        }
    }

    "generated-client JSON rejects lenient-only malformed payloads" {
        shouldThrow<SerializationException> {
            Serializer.kotlinxSerializationJson.decodeFromString<TokenPairResponse>(
                contractDriftFixture("token-pair-response-lenient-unquoted-keys.payload")
            )
        }
    }
})

private fun contractDriftFixture(name: String): String =
    requireNotNull(Thread.currentThread().contextClassLoader.getResource("contract-drift/$name")) {
        "Missing Kotlin generated-client contract drift fixture: contract-drift/$name"
    }.readText()
