package com.maintenance.field

import android.content.Context
import com.maintenance.api.client.api.DefaultApi
import com.maintenance.field.auth.CredentialManagerPasskeyClient
import com.maintenance.field.auth.MobilePasskeyStepUpRepository
import com.maintenance.field.auth.PasskeyAuthRepository
import com.maintenance.field.data.api.GeneratedMaintenanceApiGateway
import com.maintenance.field.data.collaboration.MobileOperationsRepository
import com.maintenance.field.data.evidence.EvidenceRepository
import com.maintenance.field.data.location.LocationConsentRepository
import com.maintenance.field.data.local.FieldDatabase
import com.maintenance.field.data.local.RoomMessengerOutboxStore
import com.maintenance.field.data.local.RoomMobileNotificationStore
import com.maintenance.field.data.local.RoomMobileOperationsCacheStore
import com.maintenance.field.data.local.RoomMobileSensitiveActionStore
import com.maintenance.field.data.local.RoomMutationQueueStore
import com.maintenance.field.data.local.RoomWorkOrderStore
import com.maintenance.field.data.messenger.MessengerRepository
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
    private val passkeyCredentialClient = CredentialManagerPasskeyClient()
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
    val messenger = MessengerRepository(
        gateway = apiGateway,
        outbox = RoomMessengerOutboxStore(database.messengerOutbox()),
    )
    val locationConsent = LocationConsentRepository(apiGateway)
    val mobileOperations = MobileOperationsRepository(
        gateway = apiGateway,
        cache = RoomMobileOperationsCacheStore(database.mobileOperationsSnapshots()),
        notificationStore = RoomMobileNotificationStore(database.mobileNotifications()),
        sensitiveActionStore = RoomMobileSensitiveActionStore(database.mobileSensitiveActions()),
    )
    val passkeyStepUp = MobilePasskeyStepUpRepository(
        api = apiGateway,
        credentialClient = passkeyCredentialClient,
    )
    val auth = PasskeyAuthRepository(
        api = apiGateway,
        credentialClient = passkeyCredentialClient,
        tokenStore = sessionTokenStore,
        deviceIdStore = deviceIdStore,
        appVersion = BuildConfig.VERSION_NAME,
    )
}
