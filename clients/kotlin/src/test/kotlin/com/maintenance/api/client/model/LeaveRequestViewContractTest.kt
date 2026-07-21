package com.maintenance.api.client.model

import com.maintenance.api.client.infrastructure.Serializer
import io.kotlintest.shouldBe
import io.kotlintest.shouldThrow
import io.kotlintest.specs.StringSpec
import kotlinx.serialization.SerializationException
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject

class LeaveRequestViewContractTest : StringSpec({
    "deployed v1 model still decodes the frozen legacy response" {
        val decoded = Serializer.kotlinxSerializationJson.decodeFromString<LeaveRequestView>(validV1Payload)

        decoded.days shouldBe 1.0
    }

    "deployed strict v1 model demonstrates why expanded fields require v2" {
        shouldThrow<SerializationException> {
            Serializer.kotlinxSerializationJson.decodeFromString<LeaveRequestView>(validV2Payload)
        }
    }

    "deployed v1 page still accepts items without pagination metadata" {
        val decoded = Serializer.kotlinxSerializationJson.decodeFromString<LeaveRequestPage>("""{"items":[]}""")

        decoded.items shouldBe emptyList()
    }

    "deployed strict v1 page rejects v2 pagination metadata" {
        shouldThrow<SerializationException> {
            Serializer.kotlinxSerializationJson.decodeFromString<LeaveRequestPage>(validV2LeavePage)
        }
    }

    "generated v2 client decodes required null charge_units" {
        val decoded = Serializer.kotlinxSerializationJson.decodeFromString<LeaveRequestV2View>(validV2Payload)

        decoded.chargeUnits shouldBe null
    }

    "generated v2 client re-encodes null charge_units as an explicit field" {
        val decoded = Serializer.kotlinxSerializationJson.decodeFromString<LeaveRequestV2View>(validV2Payload)
        val encoded = Serializer.kotlinxSerializationJson
            .parseToJsonElement(Serializer.kotlinxSerializationJson.encodeToString(decoded))
            .jsonObject

        encoded.containsKey("charge_units") shouldBe true
        encoded["charge_units"].toString() shouldBe "null"
    }

    "generated v2 client rejects a payload without charge_units" {
        val withoutChargeUnits = Serializer.kotlinxSerializationJson.parseToJsonElement(validV2Payload)
            .jsonObject
            .filterKeys { it != "charge_units" }
            .let(::JsonObject)
            .toString()

        shouldThrow<SerializationException> {
            Serializer.kotlinxSerializationJson.decodeFromString<LeaveRequestV2View>(withoutChargeUnits)
        }
    }

    "generated v2 client decodes required non-null days" {
        val decoded = Serializer.kotlinxSerializationJson.decodeFromString<LeaveRequestV2View>(validV2Payload)

        decoded.days shouldBe 1.0
    }

    "generated v2 client rejects a payload without days" {
        val withoutDays = Serializer.kotlinxSerializationJson.parseToJsonElement(validV2Payload)
            .jsonObject
            .filterKeys { it != "days" }
            .let(::JsonObject)
            .toString()

        shouldThrow<SerializationException> {
            Serializer.kotlinxSerializationJson.decodeFromString<LeaveRequestV2View>(withoutDays)
        }
    }

    "generated leave page preserves required null next_cursor" {
        val decoded = Serializer.kotlinxSerializationJson.decodeFromString<LeaveRequestV2Page>(validV2LeavePage)
        val encoded = Serializer.kotlinxSerializationJson
            .parseToJsonElement(Serializer.kotlinxSerializationJson.encodeToString(decoded))
            .jsonObject

        decoded.nextCursor shouldBe null
        encoded.containsKey("next_cursor") shouldBe true
        encoded["next_cursor"].toString() shouldBe "null"
    }

    "generated leave page rejects a missing next_cursor" {
        shouldThrow<SerializationException> {
            Serializer.kotlinxSerializationJson.decodeFromString<LeaveRequestV2Page>("""{"items":[]}""")
        }
    }

    "generated action page preserves required null next_cursor" {
        val decoded = Serializer.kotlinxSerializationJson.decodeFromString<ActionInboxResponse>(validActionPage)
        val encoded = Serializer.kotlinxSerializationJson
            .parseToJsonElement(Serializer.kotlinxSerializationJson.encodeToString(decoded))
            .jsonObject

        decoded.nextCursor shouldBe null
        encoded.containsKey("next_cursor") shouldBe true
        encoded["next_cursor"].toString() shouldBe "null"
    }

    "generated action page rejects a missing next_cursor" {
        shouldThrow<SerializationException> {
            Serializer.kotlinxSerializationJson.decodeFromString<ActionInboxResponse>(
                """{"items":[],"total":0,"total_is_exact":true}""",
            )
        }
    }
})

private val validV1Payload = """
    {
      "id": "00000000-0000-0000-0000-000000000001",
      "branch_id": "00000000-0000-0000-0000-000000000002",
      "requester_user_id": "00000000-0000-0000-0000-000000000003",
      "subject_employee_id": "00000000-0000-0000-0000-000000000004",
      "leave_type": "annual",
      "days": 1.0,
      "start_date": "2026-07-20",
      "end_date": "2026-07-20",
      "reason": "Annual leave",
      "status": "pending",
      "decided_by": null,
      "decided_at": null,
      "created_at": "2026-07-19T12:00:00Z"
    }
""".trimIndent()

private val validV2Payload = """
    {
      "id": "00000000-0000-0000-0000-000000000001",
      "branch_id": "00000000-0000-0000-0000-000000000002",
      "requester_user_id": "00000000-0000-0000-0000-000000000003",
      "subject_employee_id": "00000000-0000-0000-0000-000000000004",
      "leave_type": "annual",
      "days": 1.0,
      "charge_units": null,
      "charge_state": "review_required",
      "charge_review_reasons": ["missing_calendar"],
      "request_version": 1,
      "charge_version": 0,
      "start_date": "2026-07-20",
      "end_date": "2026-07-20",
      "reason": "Annual leave",
      "status": "pending",
      "decided_by": null,
      "decided_at": null,
      "created_at": "2026-07-19T12:00:00Z"
    }
""".trimIndent()

private const val validV2LeavePage = """{"items":[],"next_cursor":null}"""

private const val validActionPage =
    """{"items":[],"total":0,"total_is_exact":true,"next_cursor":null}"""
