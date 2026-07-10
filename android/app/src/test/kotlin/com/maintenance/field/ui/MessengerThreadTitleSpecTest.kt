package com.maintenance.field.ui

import com.maintenance.api.client.model.MessengerThreadKind
import com.maintenance.field.R
import com.maintenance.field.data.messenger.MessengerThread
import java.time.OffsetDateTime
import java.util.UUID
import kotlin.test.Test
import kotlin.test.assertEquals

class MessengerThreadTitleSpecTest {
    private val workOrderId = uuid("101")

    @Test
    fun customThreadTitleRemainsRuntimeData() {
        val thread = thread(
            kind = MessengerThreadKind.TEAM,
            title = "정비팀 현장 공유방",
        )

        assertEquals(
            MessengerThreadTitleSpec.RuntimeData("정비팀 현장 공유방"),
            messengerThreadTitleSpec(thread),
        )
    }

    @Test
    fun workOrderFallbackPrefersFriendlyRequestNoWhenAvailable() {
        val thread = thread(
            kind = MessengerThreadKind.WORK_ORDER,
            title = " ",
            workOrderId = workOrderId,
        )

        assertEquals(
            MessengerThreadTitleSpec.Localized(
                R.string.messenger_thread_work_order_format,
                "WO-2026-0001",
            ),
            messengerThreadTitleSpec(
                thread = thread,
                workOrderRequestNosById = mapOf(workOrderId to "WO-2026-0001"),
            ),
        )
    }

    @Test
    fun workOrderFallbackAvoidsRawIdsWhenFriendlyRequestNoIsMissing() {
        val thread = thread(
            kind = MessengerThreadKind.WORK_ORDER,
            workOrderId = workOrderId,
        )

        assertEquals(
            MessengerThreadTitleSpec.Localized(R.string.messenger_thread_work_order),
            messengerThreadTitleSpec(
                thread = thread,
                workOrderRequestNosById = mapOf(workOrderId to " "),
            ),
        )
    }

    @Test
    fun nonWorkOrderFallbacksUseStringResources() {
        assertEquals(
            MessengerThreadTitleSpec.Localized(R.string.messenger_thread_team),
            messengerThreadTitleSpec(thread(MessengerThreadKind.TEAM)),
        )
        assertEquals(
            MessengerThreadTitleSpec.Localized(R.string.messenger_thread_dm),
            messengerThreadTitleSpec(thread(MessengerThreadKind.DM)),
        )
        assertEquals(
            MessengerThreadTitleSpec.Localized(R.string.messenger_thread_group),
            messengerThreadTitleSpec(thread(MessengerThreadKind.GROUP)),
        )
    }

    private fun thread(
        kind: MessengerThreadKind,
        title: String? = null,
        workOrderId: UUID? = null,
    ): MessengerThread = MessengerThread(
        id = uuid("201"),
        kind = kind,
        branchId = uuid("301"),
        title = title,
        workOrderId = workOrderId,
        lastMessageId = null,
        lastMessageAt = null,
        memberCount = 2,
        createdAt = OffsetDateTime.parse("2026-06-12T09:00:00Z"),
        updatedAt = OffsetDateTime.parse("2026-06-12T09:00:00Z"),
    )

    private fun uuid(suffix: String): UUID =
        UUID.fromString("00000000-0000-0000-0000-${suffix.padStart(12, '0')}")
}
