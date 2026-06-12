package com.maintenance.field.data.messenger

import com.maintenance.api.client.model.MessengerMessageSummary
import com.maintenance.api.client.model.MessengerThreadSummary

fun MessengerThreadSummary.toMessengerThread(): MessengerThread =
    MessengerThread(
        id = id,
        kind = kind,
        branchId = branchId,
        title = title,
        workOrderId = workOrderId,
        lastMessageId = lastMessageId,
        lastMessageAt = lastMessageAt,
        memberCount = memberCount,
        createdAt = createdAt,
        updatedAt = updatedAt,
    )

fun MessengerMessageSummary.toMessengerMessage(): MessengerMessage =
    MessengerMessage(
        id = id,
        threadId = threadId,
        branchId = branchId,
        senderId = senderId,
        body = body,
        attachmentEvidenceIds = attachmentEvidenceIds,
        sentAt = sentAt,
        createdAt = createdAt,
    )
