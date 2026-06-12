package com.maintenance.field.data.messenger

import java.util.UUID
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener

data class MessengerRealtimeRequest(
    val url: String,
    val headers: Map<String, String>,
)

class MessengerRealtimeRequestFactory(
    private val baseUrl: String,
    private val accessToken: String,
) {
    fun build(lastMessageId: UUID? = null): MessengerRealtimeRequest {
        val url = buildString {
            append(baseUrl.trimEnd('/').replacePrefix("https://", "wss://").replacePrefix("http://", "ws://"))
            append("/api/v1/ws")
            if (lastMessageId != null) {
                append("?last_message_id=")
                append(lastMessageId)
            }
        }
        return MessengerRealtimeRequest(
            url = url,
            headers = mapOf("Authorization" to "Bearer $accessToken"),
        )
    }

    private fun String.replacePrefix(oldPrefix: String, newPrefix: String): String =
        if (startsWith(oldPrefix)) newPrefix + removePrefix(oldPrefix) else this
}

class MessengerRealtimeClient(
    private val httpClient: OkHttpClient,
    private val requestFactory: MessengerRealtimeRequestFactory,
) {
    fun connect(
        lastMessageId: UUID? = null,
        onMessage: (String) -> Unit,
        onDisconnect: () -> Unit,
        onFailure: (Throwable) -> Unit,
    ): WebSocket {
        val realtimeRequest = requestFactory.build(lastMessageId)
        val requestBuilder = Request.Builder().url(realtimeRequest.url)
        realtimeRequest.headers.forEach { (name, value) ->
            requestBuilder.header(name, value)
        }
        return httpClient.newWebSocket(
            requestBuilder.build(),
            object : WebSocketListener() {
                override fun onMessage(webSocket: WebSocket, text: String) {
                    onMessage(text)
                }

                override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                    onDisconnect()
                }

                override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                    onFailure(t)
                }
            },
        )
    }
}
