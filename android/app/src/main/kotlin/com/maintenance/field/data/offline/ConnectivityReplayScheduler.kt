package com.maintenance.field.data.offline

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch

class ConnectivityReplayScheduler(
    context: Context,
    private val scope: CoroutineScope,
    private val queue: OfflineQueueRepository,
    private val onReplayFinished: suspend () -> Unit = {},
) {
    private val connectivityManager =
        context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
    private val callback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) {
            scope.launch {
                runCatching {
                    queue.replayPending()
                    onReplayFinished()
                }
            }
        }
    }

    fun start() {
        connectivityManager.registerDefaultNetworkCallback(callback)
    }

    fun stop() {
        connectivityManager.unregisterNetworkCallback(callback)
    }
}
