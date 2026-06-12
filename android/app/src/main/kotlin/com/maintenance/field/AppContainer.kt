package com.maintenance.field

import android.content.Context
import com.maintenance.api.client.api.DefaultApi
import com.maintenance.field.auth.CredentialManagerPasskeyClient
import com.maintenance.field.auth.PasskeyAuthRepository
import com.maintenance.field.data.api.GeneratedMaintenanceApiGateway
import com.maintenance.field.data.evidence.EvidenceRepository
import com.maintenance.field.data.local.FieldDatabase
import com.maintenance.field.data.local.RoomMutationQueueStore
import com.maintenance.field.data.local.RoomWorkOrderStore
import com.maintenance.field.data.offline.OfflineQueueRepository
import com.maintenance.field.data.session.DeviceIdStore
import com.maintenance.field.data.session.SessionTokenStore
import com.maintenance.field.data.workorders.WorkOrderRepository
import okhttp3.OkHttpClient

class AppContainer(context: Context) {
    private val appContext = context.applicationContext
    private val database = FieldDatabase.create(appContext)
    private val httpClient = OkHttpClient.Builder().build()
    val sessionTokenStore = SessionTokenStore(appContext)
    val deviceIdStore = DeviceIdStore(appContext)
    private val api = DefaultApi(BuildConfig.API_BASE_URL, httpClient).also {
        it.accessTokenProvider = { sessionTokenStore.accessToken() }
    }

    val apiGateway = GeneratedMaintenanceApiGateway(api)
    val offlineQueue = OfflineQueueRepository(
        store = RoomMutationQueueStore(database.mutations()),
        syncGateway = apiGateway,
        deviceIdProvider = deviceIdStore::getOrCreate,
    )
    val workOrders = WorkOrderRepository(
        api = apiGateway,
        localStore = RoomWorkOrderStore(database.workOrders()),
        queue = offlineQueue,
    )
    val evidence = EvidenceRepository(
        api = apiGateway,
        uploads = database.evidenceUploads(),
        httpClient = httpClient,
    )
    val auth = PasskeyAuthRepository(
        api = apiGateway,
        credentialClient = CredentialManagerPasskeyClient(),
        tokenStore = sessionTokenStore,
        deviceIdStore = deviceIdStore,
        appVersion = BuildConfig.VERSION_NAME,
    )
}
