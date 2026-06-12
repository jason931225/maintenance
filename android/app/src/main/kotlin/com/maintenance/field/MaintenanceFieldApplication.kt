package com.maintenance.field

import android.app.Application
import com.maintenance.field.data.offline.ConnectivityReplayScheduler
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob

class MaintenanceFieldApplication : Application() {
    private val applicationScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    lateinit var container: AppContainer
        private set
    private lateinit var replayScheduler: ConnectivityReplayScheduler

    override fun onCreate() {
        super.onCreate()
        container = AppContainer(this)
        replayScheduler = ConnectivityReplayScheduler(
            context = this,
            scope = applicationScope,
            queue = container.offlineQueue,
            onReplayFinished = {
                container.evidence.uploadPending()
                container.workOrders.refreshToday()
            },
        )
        replayScheduler.start()
    }

    override fun onTerminate() {
        replayScheduler.stop()
        super.onTerminate()
    }
}
