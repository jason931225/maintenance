package com.maintenance.field.data.local

import androidx.room.Dao
import androidx.room.ColumnInfo
import androidx.room.Entity
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.PrimaryKey
import androidx.room.Query
import com.maintenance.api.client.infrastructure.Serializer
import com.maintenance.api.client.model.ApprovalItemsPage
import com.maintenance.api.client.model.CalendarEventResponse
import com.maintenance.api.client.model.LocationPingRequest
import com.maintenance.api.client.model.MailFolderView
import com.maintenance.api.client.model.MailThreadView
import com.maintenance.api.client.model.PollResponse
import com.maintenance.field.data.collaboration.MobileNotificationPriority
import com.maintenance.field.data.collaboration.MobileNotificationRoute
import com.maintenance.field.data.collaboration.MobileNotificationStore
import com.maintenance.field.data.collaboration.MobileOperationsCacheStore
import com.maintenance.field.data.collaboration.MobileOperationsSnapshot
import com.maintenance.field.data.collaboration.MobileQueuedActionStatus
import com.maintenance.field.data.collaboration.MobileQueuedSensitiveAction
import com.maintenance.field.data.collaboration.MobileRoutedNotification
import com.maintenance.field.data.collaboration.MobileSensitiveActionKind
import com.maintenance.field.data.collaboration.MobileSensitiveActionStore
import java.time.OffsetDateTime
import java.util.UUID
import kotlinx.serialization.builtins.ListSerializer

private const val MOBILE_OPERATIONS_SNAPSHOT_KEY = "operations_overview"

private val mobileOperationsJson = Serializer.kotlinxSerializationJson
private val mailFolderListSerializer = ListSerializer(MailFolderView.serializer())
private val mailThreadListSerializer = ListSerializer(MailThreadView.serializer())
private val calendarEventListSerializer = ListSerializer(CalendarEventResponse.serializer())
private val pollListSerializer = ListSerializer(PollResponse.serializer())

@Entity(tableName = "mobile_operations_snapshots")
data class MobileOperationsSnapshotEntity(
    @PrimaryKey val snapshotKey: String,
    val approvalsJson: String,
    val mailFoldersJson: String,
    val mailThreadsJson: String,
    val calendarEventsJson: String,
    val pollsJson: String,
    val refreshedAt: String,
)

fun MobileOperationsSnapshot.toEntity(): MobileOperationsSnapshotEntity = MobileOperationsSnapshotEntity(
    snapshotKey = MOBILE_OPERATIONS_SNAPSHOT_KEY,
    approvalsJson = mobileOperationsJson.encodeToString(ApprovalItemsPage.serializer(), approvals),
    mailFoldersJson = mobileOperationsJson.encodeToString(mailFolderListSerializer, mailFolders),
    mailThreadsJson = mobileOperationsJson.encodeToString(mailThreadListSerializer, mailThreads),
    calendarEventsJson = mobileOperationsJson.encodeToString(calendarEventListSerializer, calendarEvents),
    pollsJson = mobileOperationsJson.encodeToString(pollListSerializer, polls),
    refreshedAt = refreshedAt.toString(),
)

fun MobileOperationsSnapshotEntity.toDomain(): MobileOperationsSnapshot = MobileOperationsSnapshot(
    approvals = mobileOperationsJson.decodeFromString(ApprovalItemsPage.serializer(), approvalsJson),
    mailFolders = mobileOperationsJson.decodeFromString(mailFolderListSerializer, mailFoldersJson),
    mailThreads = mobileOperationsJson.decodeFromString(mailThreadListSerializer, mailThreadsJson),
    calendarEvents = mobileOperationsJson.decodeFromString(calendarEventListSerializer, calendarEventsJson),
    polls = mobileOperationsJson.decodeFromString(pollListSerializer, pollsJson),
    refreshedAt = OffsetDateTime.parse(refreshedAt),
)

@Dao
interface MobileOperationsSnapshotDao {
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsert(snapshot: MobileOperationsSnapshotEntity)

    @Query("SELECT * FROM mobile_operations_snapshots WHERE snapshotKey = :snapshotKey LIMIT 1")
    suspend fun get(snapshotKey: String): MobileOperationsSnapshotEntity?
}

class RoomMobileOperationsCacheStore(
    private val dao: MobileOperationsSnapshotDao,
) : MobileOperationsCacheStore {
    override suspend fun loadSnapshot(): MobileOperationsSnapshot? =
        dao.get(MOBILE_OPERATIONS_SNAPSHOT_KEY)?.toDomain()

    override suspend fun saveSnapshot(snapshot: MobileOperationsSnapshot) {
        dao.upsert(snapshot.toEntity())
    }
}

@Entity(tableName = "mobile_notifications")
data class MobileNotificationEntity(
    @PrimaryKey val id: String,
    val title: String,
    val body: String,
    val category: String,
    val priority: String,
    val route: String,
    val objectId: String?,
    val receivedAt: String,
    val readAt: String?,
)

fun MobileRoutedNotification.toEntity(): MobileNotificationEntity = MobileNotificationEntity(
    id = id,
    title = title,
    body = body,
    category = category,
    priority = priority.name,
    route = route.name,
    objectId = objectId?.toString(),
    receivedAt = receivedAt.toString(),
    readAt = readAt?.toString(),
)

fun MobileNotificationEntity.toDomain(): MobileRoutedNotification = MobileRoutedNotification(
    id = id,
    title = title,
    body = body,
    category = category,
    priority = MobileNotificationPriority.valueOf(priority),
    route = MobileNotificationRoute.valueOf(route),
    objectId = objectId?.let(UUID::fromString),
    receivedAt = OffsetDateTime.parse(receivedAt),
    readAt = readAt?.let(OffsetDateTime::parse),
)

@Dao
interface MobileNotificationDao {
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsert(notification: MobileNotificationEntity)

    @Query("SELECT * FROM mobile_notifications")
    suspend fun all(): List<MobileNotificationEntity>

    @Query("UPDATE mobile_notifications SET readAt = :readAt WHERE id = :id")
    suspend fun markRead(id: String, readAt: String)
}

class RoomMobileNotificationStore(
    private val dao: MobileNotificationDao,
) : MobileNotificationStore {
    override suspend fun loadNotifications(): List<MobileRoutedNotification> =
        dao.all().map { it.toDomain() }.sortedByDescending { it.receivedAt }

    override suspend fun saveNotification(notification: MobileRoutedNotification) {
        dao.upsert(notification.toEntity())
    }

    override suspend fun markRead(id: String, at: OffsetDateTime) {
        dao.markRead(id = id, readAt = at.toString())
    }
}

@Entity(tableName = "mobile_sensitive_actions")
data class MobileSensitiveActionEntity(
    @PrimaryKey val id: String,
    val actionKind: String,
    val objectId: String?,
    val reasonKey: String,
    val comment: String?,
    val selectedOptionIdsJson: String?,
    val deviceId: String?,
    val appVersion: String?,
    val pushToken: String?,
    val locationPingJson: String?,
    @ColumnInfo(defaultValue = "1") val nextReplayAttempt: Int,
    val createdAt: String,
    val status: String,
    val lastError: String?,
)

fun MobileQueuedSensitiveAction.toEntity(): MobileSensitiveActionEntity = MobileSensitiveActionEntity(
    id = id,
    actionKind = actionKind.name,
    objectId = objectId?.toString(),
    reasonKey = reasonKey,
    comment = comment,
    selectedOptionIdsJson = encodeUuidList(selectedOptionIds),
    deviceId = deviceId,
    appVersion = appVersion,
    pushToken = pushToken,
    locationPingJson = locationPing?.let { mobileOperationsJson.encodeToString(LocationPingRequest.serializer(), it) },
    nextReplayAttempt = nextReplayAttempt,
    createdAt = createdAt.toString(),
    status = status.name,
    lastError = lastError,
)

fun MobileSensitiveActionEntity.toDomain(): MobileQueuedSensitiveAction = MobileQueuedSensitiveAction(
    id = id,
    actionKind = MobileSensitiveActionKind.valueOf(actionKind),
    objectId = objectId?.let(UUID::fromString),
    reasonKey = reasonKey,
    comment = comment,
    selectedOptionIds = decodeUuidList(selectedOptionIdsJson),
    deviceId = deviceId,
    appVersion = appVersion,
    pushToken = pushToken,
    locationPing = locationPingJson?.let { mobileOperationsJson.decodeFromString(LocationPingRequest.serializer(), it) },
    nextReplayAttempt = nextReplayAttempt,
    createdAt = OffsetDateTime.parse(createdAt),
    status = MobileQueuedActionStatus.valueOf(status),
    lastError = lastError,
)

private fun encodeUuidList(values: List<UUID>): String? =
    values.takeIf { it.isNotEmpty() }?.joinToString(",")

private fun decodeUuidList(value: String?): List<UUID> =
    value
        ?.takeIf { it.isNotBlank() }
        ?.split(',')
        ?.map(UUID::fromString)
        ?: emptyList()

@Dao
interface MobileSensitiveActionDao {
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsert(action: MobileSensitiveActionEntity)

    @Query("SELECT * FROM mobile_sensitive_actions WHERE status != 'SUBMITTED'")
    suspend fun pending(): List<MobileSensitiveActionEntity>

    @Query("SELECT * FROM mobile_sensitive_actions WHERE id = :id LIMIT 1")
    suspend fun get(id: String): MobileSensitiveActionEntity?

    @Query("UPDATE mobile_sensitive_actions SET status = 'SUBMITTED', lastError = NULL WHERE id = :id")
    suspend fun markSubmitted(id: String)

    @Query("UPDATE mobile_sensitive_actions SET status = 'FAILED', lastError = :message WHERE id = :id")
    suspend fun markFailed(id: String, message: String)
}

class RoomMobileSensitiveActionStore(
    private val dao: MobileSensitiveActionDao,
) : MobileSensitiveActionStore {
    override suspend fun upsert(action: MobileQueuedSensitiveAction) {
        dao.upsert(action.toEntity())
    }

    override suspend fun pending(): List<MobileQueuedSensitiveAction> =
        dao.pending().map { it.toDomain() }.sortedBy { it.createdAt }

    override suspend fun get(id: String): MobileQueuedSensitiveAction? = dao.get(id)?.toDomain()

    override suspend fun markSubmitted(id: String) {
        dao.markSubmitted(id)
    }

    override suspend fun markFailed(id: String, message: String) {
        dao.markFailed(id, message)
    }
}
