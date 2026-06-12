package com.maintenance.field.data.messenger

class MessengerReducer {
    fun reduce(state: MessengerState, action: MessengerAction): MessengerState =
        when (action) {
            is MessengerAction.ThreadsLoaded -> state.copy(
                threads = action.threads.sortedThreadsForDisplay(),
                selectedThreadId = state.selectedThreadId ?: action.threads.firstOrNull()?.id,
            )
            is MessengerAction.ThreadSelected -> state.copy(selectedThreadId = action.threadId)
            is MessengerAction.MessagesPageLoaded -> {
                val messages = mergeMessages(
                    state.messagesByThread[action.threadId].orEmpty(),
                    action.page.items,
                )
                state.copy(
                    messagesByThread = state.messagesByThread + (action.threadId to messages),
                    nextCursorByThread = state.nextCursorByThread + (action.threadId to action.page.nextCursor),
                    lastMessageIdByThread = messages.lastOrNull()?.let {
                        state.lastMessageIdByThread + (action.threadId to it.id)
                    } ?: state.lastMessageIdByThread,
                )
            }
            is MessengerAction.LiveMessageReceived -> state.upsertMessage(action.message)
            is MessengerAction.MessageSent -> state.upsertMessage(action.message)
            is MessengerAction.SearchResultsLoaded -> state.copy(
                searchResults = action.messages.sortedMessagesForDisplay(),
            )
        }

    private fun MessengerState.upsertMessage(message: MessengerMessage): MessengerState {
        val messages = mergeMessages(messagesByThread[message.threadId].orEmpty(), listOf(message))
        return copy(
            threads = threads.map { thread ->
                if (thread.id == message.threadId) {
                    thread.copy(
                        lastMessageId = message.id,
                        lastMessageAt = message.sentAt,
                        updatedAt = message.createdAt,
                    )
                } else {
                    thread
                }
            }.sortedThreadsForDisplay(),
            messagesByThread = messagesByThread + (message.threadId to messages),
            lastMessageIdByThread = lastMessageIdByThread + (message.threadId to message.id),
        )
    }

    private fun mergeMessages(
        existing: List<MessengerMessage>,
        incoming: List<MessengerMessage>,
    ): List<MessengerMessage> =
        (existing + incoming)
            .associateBy { it.id }
            .values
            .toList()
            .sortedMessagesForDisplay()
}

private fun List<MessengerMessage>.sortedMessagesForDisplay(): List<MessengerMessage> =
    sortedWith(compareBy<MessengerMessage> { it.sentAt }.thenBy { it.id })

private fun List<MessengerThread>.sortedThreadsForDisplay(): List<MessengerThread> =
    sortedWith(
        compareByDescending<MessengerThread> { it.lastMessageAt ?: it.updatedAt }
            .thenBy { it.id },
    )
