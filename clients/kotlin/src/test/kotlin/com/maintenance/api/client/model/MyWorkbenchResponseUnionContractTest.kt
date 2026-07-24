package com.maintenance.api.client.model

import com.maintenance.api.client.infrastructure.Serializer
import io.kotlintest.shouldBe
import io.kotlintest.shouldThrow
import io.kotlintest.specs.StringSpec
import java.util.UUID
import kotlinx.serialization.SerializationException
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

class MyWorkbenchResponseUnionContractTest : StringSpec({
    "generated workbench client decodes branch scope and each source envelope variant" {
        val decoded = Serializer.kotlinxSerializationJson.decodeFromString<MyWorkbenchResponse>(
            branchScopeWithAllSourceVariants,
        )

        val scope: Any = decoded.scope
        scope::class shouldBe WorkbenchScopeBranches::class
        val branches = scope as WorkbenchScopeBranches
        branches.kind shouldBe WorkbenchScopeBranches.Kind.BRANCHES
        branches.branchIds shouldBe setOf(branchId)
        branches.selectedBranchId shouldBe branchId

        val actionInbox: Any = decoded.actionInbox
        actionInbox::class shouldBe WorkbenchActionSourceOk::class
        val actionInboxOk = actionInbox as WorkbenchActionSourceOk
        actionInboxOk.status shouldBe WorkbenchActionSourceOk.Status.OK
        actionInboxOk.total shouldBe 3
        actionInboxOk.truncated shouldBe true
        actionInboxOk.items.single().title shouldBe "Approve purchase order"

        val todos: Any = decoded.todos
        todos::class shouldBe WorkbenchDeniedSourceEnvelope::class
        val todosDenied = todos as WorkbenchDeniedSourceEnvelope
        todosDenied.status shouldBe WorkbenchDeniedSourceEnvelope.Status.DENIED
        todosDenied.code shouldBe "todos_not_authorized"

        val calendar: Any = decoded.calendar
        calendar::class shouldBe WorkbenchUnavailableSourceEnvelope::class
        val calendarUnavailable = calendar as WorkbenchUnavailableSourceEnvelope
        calendarUnavailable.status shouldBe WorkbenchUnavailableSourceEnvelope.Status.UNAVAILABLE
        calendarUnavailable.code shouldBe "calendar_upstream_unavailable"
    }

    "generated workbench client decodes all scope and complementary source envelope variants" {
        val decoded = Serializer.kotlinxSerializationJson.decodeFromString<MyWorkbenchResponse>(
            allScopeWithComplementarySourceVariants,
        )

        val scope: Any = decoded.scope
        scope::class shouldBe WorkbenchScopeAll::class
        val all = scope as WorkbenchScopeAll
        all.kind shouldBe WorkbenchScopeAll.Kind.ALL
        all.selectedBranchId shouldBe null

        val actionInbox: Any = decoded.actionInbox
        actionInbox::class shouldBe WorkbenchDeniedSourceEnvelope::class
        (actionInbox as WorkbenchDeniedSourceEnvelope).code shouldBe "action_inbox_not_authorized"

        val todos: Any = decoded.todos
        todos::class shouldBe WorkbenchUnavailableSourceEnvelope::class
        (todos as WorkbenchUnavailableSourceEnvelope).code shouldBe "todos_upstream_unavailable"

        val calendar: Any = decoded.calendar
        calendar::class shouldBe WorkbenchCalendarSourceOk::class
        val calendarOk = calendar as WorkbenchCalendarSourceOk
        calendarOk.status shouldBe WorkbenchCalendarSourceOk.Status.OK
        calendarOk.total shouldBe 1
        calendarOk.items.single().title shouldBe "Safety inspection"
    }

    "generated workbench response round trips branch scope with all source variants" {
        val decoded = Serializer.kotlinxSerializationJson.decodeFromString<MyWorkbenchResponse>(
            branchScopeWithAllSourceVariants,
        )
        val encoded = Serializer.kotlinxSerializationJson.encodeToString(decoded)

        assertExactWorkbenchResponseWire(
            encoded = encoded,
            expectedScopeKind = "branches",
            expectedActionStatus = "ok",
            expectedTodoStatus = "denied",
            expectedCalendarStatus = "unavailable",
        )
        Serializer.kotlinxSerializationJson.decodeFromString<MyWorkbenchResponse>(encoded) shouldBe decoded
    }

    "generated workbench response round trips all scope with complementary source variants" {
        val decoded = Serializer.kotlinxSerializationJson.decodeFromString<MyWorkbenchResponse>(
            allScopeWithComplementarySourceVariants,
        )
        val encoded = Serializer.kotlinxSerializationJson.encodeToString(decoded)

        assertExactWorkbenchResponseWire(
            encoded = encoded,
            expectedScopeKind = "all",
            expectedActionStatus = "denied",
            expectedTodoStatus = "unavailable",
            expectedCalendarStatus = "ok",
        )
        Serializer.kotlinxSerializationJson.decodeFromString<MyWorkbenchResponse>(encoded) shouldBe decoded
    }

    "generated workbench client decodes the remaining mapped source envelope variants" {
        val decoded = Serializer.kotlinxSerializationJson.decodeFromString<MyWorkbenchResponse>(
            remainingSourceVariants,
        )

        val actionInbox: Any = decoded.actionInbox
        actionInbox::class shouldBe WorkbenchUnavailableSourceEnvelope::class
        (actionInbox as WorkbenchUnavailableSourceEnvelope).code shouldBe "action_inbox_upstream_unavailable"

        val todos: Any = decoded.todos
        todos::class shouldBe WorkbenchTodoSourceOk::class
        val todosOk = todos as WorkbenchTodoSourceOk
        todosOk.status shouldBe WorkbenchTodoSourceOk.Status.OK
        todosOk.total shouldBe 1
        todosOk.items.single().text shouldBe "Review safety checklist"

        val calendar: Any = decoded.calendar
        calendar::class shouldBe WorkbenchDeniedSourceEnvelope::class
        (calendar as WorkbenchDeniedSourceEnvelope).code shouldBe "calendar_not_authorized"
    }

    "generated workbench client decodes denied source through every static parent type" {
        decodeActionEnvelope(deniedSourcePayload)::class shouldBe WorkbenchDeniedSourceEnvelope::class
        decodeTodoEnvelope(deniedSourcePayload)::class shouldBe WorkbenchDeniedSourceEnvelope::class
        decodeCalendarEnvelope(deniedSourcePayload)::class shouldBe WorkbenchDeniedSourceEnvelope::class
    }

    "generated workbench client decodes unavailable source through every static parent type" {
        decodeActionEnvelope(unavailableSourcePayload)::class shouldBe WorkbenchUnavailableSourceEnvelope::class
        decodeTodoEnvelope(unavailableSourcePayload)::class shouldBe WorkbenchUnavailableSourceEnvelope::class
        decodeCalendarEnvelope(unavailableSourcePayload)::class shouldBe WorkbenchUnavailableSourceEnvelope::class
    }

    "generated workbench client round trips every action source subtype through its parent" {
        actionEnvelopeVariants.forEach { (payload, expectedStatus, implementationName) ->
            val decoded = decodeActionEnvelope(payload)
            val encoded = Serializer.kotlinxSerializationJson.encodeToString<WorkbenchActionSourceEnvelope>(decoded)

            assertExactEnvelopeWire(encoded, expectedStatus, implementationName)
            decodeActionEnvelope(encoded) shouldBe decoded
        }
    }

    "generated workbench client round trips every todo source subtype through its parent" {
        todoEnvelopeVariants.forEach { (payload, expectedStatus, implementationName) ->
            val decoded = decodeTodoEnvelope(payload)
            val encoded = Serializer.kotlinxSerializationJson.encodeToString<WorkbenchTodoSourceEnvelope>(decoded)

            assertExactEnvelopeWire(encoded, expectedStatus, implementationName)
            decodeTodoEnvelope(encoded) shouldBe decoded
        }
    }

    "generated workbench client round trips every calendar source subtype through its parent" {
        calendarEnvelopeVariants.forEach { (payload, expectedStatus, implementationName) ->
            val decoded = decodeCalendarEnvelope(payload)
            val encoded = Serializer.kotlinxSerializationJson.encodeToString<WorkbenchCalendarSourceEnvelope>(decoded)

            assertExactEnvelopeWire(encoded, expectedStatus, implementationName)
            decodeCalendarEnvelope(encoded) shouldBe decoded
        }
    }

    "generated workbench client round trips branch scope through its parent" {
        val decoded = decodeScope(branchScopePayload)
        val encoded = Serializer.kotlinxSerializationJson.encodeToString<WorkbenchEffectiveScope>(decoded)

        assertExactScopeWire(encoded, "branches", "WorkbenchScopeBranches")
        decodeScope(encoded) shouldBe decoded
    }

    "generated workbench client round trips all scope through its parent" {
        val decoded = decodeScope(allScopePayload)
        val encoded = Serializer.kotlinxSerializationJson.encodeToString<WorkbenchEffectiveScope>(decoded)

        assertExactScopeWire(encoded, "all", "WorkbenchScopeAll")
        decodeScope(encoded) shouldBe decoded
    }

    "generated source parents reject missing and unknown status discriminators" {
        listOf(
            "{}",
            """{"status":"unexpected","code":"not_supported"}""",
        ).forEach(::assertEverySourceEnvelopeRejected)
    }

    "generated source parents reject null numeric boolean and object status discriminators" {
        listOf("null", "1", "true", "{}")
            .map { discriminator -> """{"status":$discriminator,"code":"not_supported"}""" }
            .forEach(::assertEverySourceEnvelopeRejected)
    }

    "generated source parents reject malformed ok child bodies" {
        assertEverySourceEnvelopeRejected(
            """{"status":"ok","as_of":"2026-07-22T12:00:00Z","items":[],"total":1}""",
        )
    }

    "generated source parents reject unknown child fields" {
        assertEverySourceEnvelopeRejected(
            """{"status":"denied","code":"not_authorized","unexpected":true}""",
        )
    }

    "generated scope parent rejects missing and unknown kind discriminators" {
        listOf(
            "{}",
            """{"kind":"selected","branch_ids":[]}""",
        ).forEach(::assertScopeRejected)
    }

    "generated scope parent rejects non-string kind discriminators" {
        listOf("null", "1", "true", "{}")
            .map { discriminator -> """{"kind":$discriminator,"branch_ids":[]}""" }
            .forEach(::assertScopeRejected)
    }

    "generated scope parent rejects malformed selected child bodies" {
        assertScopeRejected("""{"kind":"branches"}""")
    }

    "generated scope parent rejects unknown child fields" {
        assertScopeRejected("""{"kind":"all","unexpected":true}""")
    }
})

private fun decodeActionEnvelope(payload: String): WorkbenchActionSourceEnvelope =
    Serializer.kotlinxSerializationJson.decodeFromString(payload)

private fun decodeTodoEnvelope(payload: String): WorkbenchTodoSourceEnvelope =
    Serializer.kotlinxSerializationJson.decodeFromString(payload)

private fun decodeCalendarEnvelope(payload: String): WorkbenchCalendarSourceEnvelope =
    Serializer.kotlinxSerializationJson.decodeFromString(payload)

private fun decodeScope(payload: String): WorkbenchEffectiveScope =
    Serializer.kotlinxSerializationJson.decodeFromString(payload)

private fun assertEverySourceEnvelopeRejected(payload: String) {
    shouldThrow<SerializationException> { decodeActionEnvelope(payload) }
    shouldThrow<SerializationException> { decodeTodoEnvelope(payload) }
    shouldThrow<SerializationException> { decodeCalendarEnvelope(payload) }
}

private fun assertScopeRejected(payload: String) {
    shouldThrow<SerializationException> { decodeScope(payload) }
}

private fun assertExactWorkbenchResponseWire(
    encoded: String,
    expectedScopeKind: String,
    expectedActionStatus: String,
    expectedTodoStatus: String,
    expectedCalendarStatus: String,
) {
    val json = Serializer.kotlinxSerializationJson.parseToJsonElement(encoded).jsonObject
    val scope = json["scope"]?.jsonObject ?: error("response must encode scope")
    val actionInbox = json["action_inbox"]?.jsonObject ?: error("response must encode action_inbox")
    val todos = json["todos"]?.jsonObject ?: error("response must encode todos")
    val calendar = json["calendar"]?.jsonObject ?: error("response must encode calendar")

    scope["kind"]?.jsonPrimitive?.content shouldBe expectedScopeKind
    scope.keys.count { it == "kind" } shouldBe 1
    actionInbox["status"]?.jsonPrimitive?.content shouldBe expectedActionStatus
    todos["status"]?.jsonPrimitive?.content shouldBe expectedTodoStatus
    calendar["status"]?.jsonPrimitive?.content shouldBe expectedCalendarStatus
    encoded.split("\"status\"").size - 1 shouldBe 3
    encoded.contains("WorkbenchScope") shouldBe false
    encoded.contains("WorkbenchActionSource") shouldBe false
    encoded.contains("WorkbenchTodoSource") shouldBe false
    encoded.contains("WorkbenchCalendarSource") shouldBe false
    encoded.contains("WorkbenchDeniedSourceEnvelope") shouldBe false
    encoded.contains("WorkbenchUnavailableSourceEnvelope") shouldBe false
}

private fun assertExactEnvelopeWire(
    encoded: String,
    expectedStatus: String,
    implementationName: String,
) {
    val json = Serializer.kotlinxSerializationJson.parseToJsonElement(encoded).jsonObject

    json["status"]?.jsonPrimitive?.content shouldBe expectedStatus
    Regex("\\\"status\\\"").findAll(encoded).count() shouldBe 1
    encoded.contains(implementationName) shouldBe false
}

private fun assertExactScopeWire(
    encoded: String,
    expectedKind: String,
    implementationName: String,
) {
    val json = Serializer.kotlinxSerializationJson.parseToJsonElement(encoded).jsonObject

    json["kind"]?.jsonPrimitive?.content shouldBe expectedKind
    Regex("\\\"kind\\\"").findAll(encoded).count() shouldBe 1
    encoded.contains(implementationName) shouldBe false
}

private val branchId: UUID = UUID.fromString("00000000-0000-0000-0000-0000000000a1")

private val actionOkPayload = """
    {"status":"ok","as_of":"2026-07-22T12:00:00Z","items":[],"total":0,"truncated":false}
""".trimIndent()

private val todoOkPayload = """
    {"status":"ok","as_of":"2026-07-22T12:00:00Z","items":[],"total":0,"truncated":false}
""".trimIndent()

private val calendarOkPayload = """
    {"status":"ok","as_of":"2026-07-22T12:00:00Z","items":[],"total":0,"truncated":false}
""".trimIndent()

private val deniedSourcePayload = """
    {"status":"denied","code":"not_authorized"}
""".trimIndent()

private val unavailableSourcePayload = """
    {"status":"unavailable","code":"upstream_unavailable"}
""".trimIndent()

private val actionEnvelopeVariants = listOf(
    Triple(actionOkPayload, "ok", "WorkbenchActionSourceOk"),
    Triple(deniedSourcePayload, "denied", "WorkbenchDeniedSourceEnvelope"),
    Triple(unavailableSourcePayload, "unavailable", "WorkbenchUnavailableSourceEnvelope"),
)

private val todoEnvelopeVariants = listOf(
    Triple(todoOkPayload, "ok", "WorkbenchTodoSourceOk"),
    Triple(deniedSourcePayload, "denied", "WorkbenchDeniedSourceEnvelope"),
    Triple(unavailableSourcePayload, "unavailable", "WorkbenchUnavailableSourceEnvelope"),
)

private val calendarEnvelopeVariants = listOf(
    Triple(calendarOkPayload, "ok", "WorkbenchCalendarSourceOk"),
    Triple(deniedSourcePayload, "denied", "WorkbenchDeniedSourceEnvelope"),
    Triple(unavailableSourcePayload, "unavailable", "WorkbenchUnavailableSourceEnvelope"),
)

private val branchScopePayload = """
    {"kind":"branches","branch_ids":["00000000-0000-0000-0000-0000000000a1"],"selected_branch_id":"00000000-0000-0000-0000-0000000000a1"}
""".trimIndent()

private val allScopePayload = """
    {"kind":"all","selected_branch_id":null}
""".trimIndent()

private val branchScopeWithAllSourceVariants = """
    {
      "as_of": "2026-07-22T12:00:00Z",
      "timezone": "Asia/Seoul",
      "range": {"from": "2026-07-22T00:00:00Z", "to": "2026-07-23T00:00:00Z"},
      "scope": {
        "kind": "branches",
        "branch_ids": ["00000000-0000-0000-0000-0000000000a1"],
        "selected_branch_id": "00000000-0000-0000-0000-0000000000a1"
      },
      "partial": true,
      "action_inbox": {
        "status": "ok",
        "as_of": "2026-07-22T12:00:00Z",
        "items": [{
          "id": "approval-1",
          "urgency": "now",
          "title": "Approve purchase order",
          "source": {"kind": "purchase_order", "id": "00000000-0000-0000-0000-000000000111"},
          "target": {"module": "procurement", "id": "po-1"}
        }],
        "total": 3,
        "truncated": true
      },
      "todos": {"status": "denied", "code": "todos_not_authorized"},
      "calendar": {"status": "unavailable", "code": "calendar_upstream_unavailable"}
    }
""".trimIndent()

private val allScopeWithComplementarySourceVariants = """
    {
      "as_of": "2026-07-22T12:00:00Z",
      "timezone": "Asia/Seoul",
      "range": {"from": "2026-07-22T00:00:00Z", "to": "2026-07-23T00:00:00Z"},
      "scope": {"kind": "all"},
      "partial": true,
      "action_inbox": {"status": "denied", "code": "action_inbox_not_authorized"},
      "todos": {"status": "unavailable", "code": "todos_upstream_unavailable"},
      "calendar": {
        "status": "ok",
        "as_of": "2026-07-22T12:00:00Z",
        "items": [{
          "id": "00000000-0000-0000-0000-000000000222",
          "title": "Safety inspection",
          "starts_at": "2026-07-22T13:00:00Z",
          "ends_at": "2026-07-22T14:00:00Z",
          "target": {"module": "operations", "id": "inspection-1"}
        }],
        "total": 1,
        "truncated": false
      }
    }
""".trimIndent()

private val remainingSourceVariants = """
    {
      "as_of": "2026-07-22T12:00:00Z",
      "timezone": "Asia/Seoul",
      "range": {"from": "2026-07-22T00:00:00Z", "to": "2026-07-23T00:00:00Z"},
      "scope": {"kind": "all"},
      "partial": true,
      "action_inbox": {"status": "unavailable", "code": "action_inbox_upstream_unavailable"},
      "todos": {
        "status": "ok",
        "as_of": "2026-07-22T12:00:00Z",
        "items": [{
          "id": "00000000-0000-0000-0000-000000000333",
          "text": "Review safety checklist",
          "done": false,
          "source_order": 1,
          "target": {"module": "operations", "id": "checklist-1"}
        }],
        "total": 1,
        "truncated": false
      },
      "calendar": {"status": "denied", "code": "calendar_not_authorized"}
    }
""".trimIndent()
