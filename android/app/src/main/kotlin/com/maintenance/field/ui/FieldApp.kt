package com.maintenance.field.ui

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.annotation.StringRes
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.maintenance.api.client.model.AttachmentStage
import com.maintenance.api.client.model.CollaborationScopeType
import com.maintenance.api.client.model.LocationConsentState
import com.maintenance.api.client.model.LocationConsentStatus
import com.maintenance.api.client.model.MessengerThreadKind
import com.maintenance.api.client.model.PollAnonymity
import com.maintenance.api.client.model.PollStatus
import com.maintenance.api.client.model.PriorityLevel
import com.maintenance.api.client.model.WorkOrderStatus
import com.maintenance.api.client.model.WorkResultType
import com.maintenance.field.AppContainer
import com.maintenance.field.R
import com.maintenance.field.auth.DeviceRegistrationState
import com.maintenance.field.auth.LoginState
import com.maintenance.field.data.api.ReportDraft
import com.maintenance.field.data.api.TechnicianWorkOrder
import com.maintenance.field.data.collaboration.MobileCalendarEventRow
import com.maintenance.field.data.collaboration.MobileMailThreadRow
import com.maintenance.field.data.collaboration.MobileNotificationInbox
import com.maintenance.field.data.collaboration.MobileOperationsDashboard
import com.maintenance.field.data.collaboration.MobileOperationsOverview
import com.maintenance.field.data.collaboration.MobileOperationsSnapshotOrigin
import com.maintenance.field.data.collaboration.MobilePollRow
import com.maintenance.field.data.collaboration.MobileRoutedNotification
import com.maintenance.field.data.collaboration.MobileSensitiveActionKind
import com.maintenance.field.data.collaboration.MobileSensitiveActionQueueSummary
import com.maintenance.field.data.messenger.MessengerAction
import com.maintenance.field.data.messenger.MessengerMessage
import com.maintenance.field.data.messenger.MessengerReducer
import com.maintenance.field.data.messenger.MessengerSendState
import com.maintenance.field.data.messenger.MessengerState
import com.maintenance.field.data.messenger.MessengerThread
import com.maintenance.field.data.offline.SyncState
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import java.util.UUID
import kotlinx.coroutines.launch

private val messengerTimestampFormatter: DateTimeFormatter =
    DateTimeFormatter.ofLocalizedDateTime(FormatStyle.SHORT).withZone(ZoneId.systemDefault())

private const val OPERATIONS_PASSKEY_APPROVAL_DECISION_REASON_KEY = "operations_passkey_approval_decision"
private const val OPERATIONS_PASSKEY_POLL_VOTE_REASON_KEY = "operations_passkey_poll_vote"

internal enum class MobileCollaborationKind {
    NOTIFICATION,
    APPROVAL,
    PASSKEY_SIGNING,
    OFFLINE_SYNC,
    MESSENGER,
    MAIL,
    CALENDAR,
    POLL,
}

internal enum class MobileCollaborationStatus(@get:StringRes val labelRes: Int) {
    ACTION_REQUIRED(R.string.work_hub_status_action_required),
    READY(R.string.work_hub_status_ready),
    MONITORING(R.string.work_hub_status_monitoring),
}

internal data class MobileCollaborationAction(
    val kind: MobileCollaborationKind,
    @get:StringRes val titleRes: Int,
    @get:StringRes val valueRes: Int,
    @get:StringRes val detailRes: Int,
    val count: Int?,
    val status: MobileCollaborationStatus,
    val requiresPasskey: Boolean = false,
)

internal fun buildMobileCollaborationActions(
    urgentWorkCount: Int,
    approvalRelatedCount: Int,
    pendingSyncCount: Int,
    messengerThreadCount: Int,
    targetDueWorkCount: Int,
): List<MobileCollaborationAction> {
    val notificationCount = urgentWorkCount + approvalRelatedCount + pendingSyncCount
    return listOf(
        MobileCollaborationAction(
            kind = MobileCollaborationKind.NOTIFICATION,
            titleRes = R.string.work_hub_action_notifications_title,
            valueRes = R.string.work_hub_action_notifications_value_format,
            detailRes = R.string.work_hub_action_notifications_detail,
            count = notificationCount,
            status = if (notificationCount > 0) MobileCollaborationStatus.ACTION_REQUIRED else MobileCollaborationStatus.MONITORING,
        ),
        MobileCollaborationAction(
            kind = MobileCollaborationKind.APPROVAL,
            titleRes = R.string.work_hub_action_approvals_title,
            valueRes = R.string.work_hub_action_approvals_value_format,
            detailRes = R.string.work_hub_action_approvals_detail,
            count = approvalRelatedCount,
            status = if (approvalRelatedCount > 0) MobileCollaborationStatus.ACTION_REQUIRED else MobileCollaborationStatus.MONITORING,
            requiresPasskey = approvalRelatedCount > 0,
        ),
        MobileCollaborationAction(
            kind = MobileCollaborationKind.PASSKEY_SIGNING,
            titleRes = R.string.work_hub_action_passkey_title,
            valueRes = if (approvalRelatedCount > 0) {
                R.string.work_hub_action_passkey_value_required
            } else {
                R.string.work_hub_action_passkey_value_ready
            },
            detailRes = R.string.work_hub_action_passkey_detail,
            count = null,
            status = if (approvalRelatedCount > 0) MobileCollaborationStatus.ACTION_REQUIRED else MobileCollaborationStatus.READY,
            requiresPasskey = true,
        ),
        MobileCollaborationAction(
            kind = MobileCollaborationKind.OFFLINE_SYNC,
            titleRes = R.string.work_hub_action_offline_title,
            valueRes = R.string.work_hub_action_offline_value_format,
            detailRes = R.string.work_hub_action_offline_detail,
            count = pendingSyncCount,
            status = if (pendingSyncCount > 0) MobileCollaborationStatus.ACTION_REQUIRED else MobileCollaborationStatus.READY,
        ),
        MobileCollaborationAction(
            kind = MobileCollaborationKind.MESSENGER,
            titleRes = R.string.work_hub_action_messenger_title,
            valueRes = R.string.work_hub_action_messenger_value_format,
            detailRes = R.string.work_hub_action_messenger_detail,
            count = messengerThreadCount,
            status = MobileCollaborationStatus.READY,
        ),
        MobileCollaborationAction(
            kind = MobileCollaborationKind.MAIL,
            titleRes = R.string.work_hub_action_mail_title,
            valueRes = R.string.work_hub_action_mail_value_ready,
            detailRes = R.string.work_hub_action_mail_detail,
            count = null,
            status = MobileCollaborationStatus.READY,
        ),
        MobileCollaborationAction(
            kind = MobileCollaborationKind.CALENDAR,
            titleRes = R.string.work_hub_action_calendar_title,
            valueRes = R.string.work_hub_action_calendar_value_format,
            detailRes = R.string.work_hub_action_calendar_detail,
            count = targetDueWorkCount,
            status = MobileCollaborationStatus.READY,
        ),
        MobileCollaborationAction(
            kind = MobileCollaborationKind.POLL,
            titleRes = R.string.work_hub_action_polls_title,
            valueRes = R.string.work_hub_action_polls_value_ready,
            detailRes = R.string.work_hub_action_polls_detail,
            count = null,
            status = MobileCollaborationStatus.READY,
        ),
    )
}

internal data class WorkHubSummary(
    val todayWorkCount: Int,
    val urgentWorkCount: Int,
    val approvalRelatedCount: Int,
    val pendingSyncCount: Int,
    val messengerThreadCount: Int,
    val targetDueWorkCount: Int,
    val gpsMayCollect: Boolean,
    val collaborationActions: List<MobileCollaborationAction>,
) {
    companion object {
        fun build(
            today: List<TechnicianWorkOrder>,
            messengerState: MessengerState,
            gpsMayCollect: Boolean,
        ): WorkHubSummary {
            val urgentWorkCount = today.count { it.priority == PriorityLevel.P1 }
            val approvalRelatedCount = today.count {
                it.status == WorkOrderStatus.REPORT_SUBMITTED || it.status == WorkOrderStatus.ADMIN_REVIEW
            }
            val pendingSyncCount = today.count { it.syncState != SyncState.SYNCED }
            val messengerThreadCount = messengerState.threads.size
            val targetDueWorkCount = today.count { it.targetDueAt != null }

            return WorkHubSummary(
                todayWorkCount = today.size,
                urgentWorkCount = urgentWorkCount,
                approvalRelatedCount = approvalRelatedCount,
                pendingSyncCount = pendingSyncCount,
                messengerThreadCount = messengerThreadCount,
                targetDueWorkCount = targetDueWorkCount,
                gpsMayCollect = gpsMayCollect,
                collaborationActions = buildMobileCollaborationActions(
                    urgentWorkCount = urgentWorkCount,
                    approvalRelatedCount = approvalRelatedCount,
                    pendingSyncCount = pendingSyncCount,
                    messengerThreadCount = messengerThreadCount,
                    targetDueWorkCount = targetDueWorkCount,
                ),
            )
        }
    }
}

@Composable
fun FieldApp(container: AppContainer) {
    val context = LocalContext.current
    val orders by container.workOrders.observeToday().collectAsStateWithLifecycle(initialValue = emptyList())
    val snackbarHostState = remember { SnackbarHostState() }
    val scope = rememberCoroutineScope()
    var authenticated by rememberSaveable { mutableStateOf(container.auth.hasSession()) }
    var selectedId by rememberSaveable { mutableStateOf<String?>(null) }
    var selectedTab by rememberSaveable { mutableStateOf(0) }
    var showCamera by rememberSaveable { mutableStateOf(false) }
    var busy by rememberSaveable { mutableStateOf(false) }
    var currentUserId by rememberSaveable { mutableStateOf<UUID?>(null) }
    var messengerState by remember { mutableStateOf(MessengerState()) }
    var messengerSearchQuery by rememberSaveable { mutableStateOf("") }
    var messengerDraft by rememberSaveable { mutableStateOf("") }
    var locationConsent by remember { mutableStateOf<LocationConsentStatus?>(null) }
    var operationsOverview by remember { mutableStateOf<MobileOperationsOverview?>(null) }
    var approvalComment by rememberSaveable { mutableStateOf("") }
    var notificationInbox by remember { mutableStateOf(MobileNotificationInbox(emptyList())) }
    var sensitiveActionSummary by remember { mutableStateOf(MobileSensitiveActionQueueSummary(emptyList())) }
    val selected = orders.firstOrNull { it.id.toString() == selectedId }
    val messengerReducer = remember { MessengerReducer() }
    val loginFailedMessage = stringResource(R.string.login_failed)
    val deviceRegistrationRetryPendingMessage = stringResource(R.string.device_registration_retry_pending)
    val offlineQueuedMessage = stringResource(R.string.offline_queued)
    val reportSubmittedMessage = stringResource(R.string.report_submitted)
    val cameraPermissionDeniedMessage = stringResource(R.string.camera_permission_denied)
    val operationFailedMessage = stringResource(R.string.operation_failed)
    val messengerSendPendingMessage = stringResource(R.string.messenger_send_pending)
    val locationConsentFailedMessage = stringResource(R.string.location_consent_failed)
    val operationsPasskeyRequiredMessage = stringResource(R.string.operations_passkey_required)
    val operationsPollVotedMessage = stringResource(R.string.operations_poll_voted)

    suspend fun loadMessengerMessages(threadId: UUID, beforeMessageId: UUID? = null) {
        val page = container.messenger.loadMessages(threadId, beforeMessageId)
        messengerState = messengerReducer.reduce(
            messengerState,
            MessengerAction.MessagesPageLoaded(threadId, page),
        )
        messengerState.messagesByThread[threadId]?.lastOrNull()?.let {
            runCatching { container.messenger.markRead(threadId, it.id) }
        }
    }

    suspend fun refreshMessenger() {
        container.messenger.replayPending()
        val threads = container.messenger.loadThreads()
        messengerState = messengerReducer.reduce(messengerState, MessengerAction.ThreadsLoaded(threads))
        messengerState.selectedThreadId?.let { loadMessengerMessages(it) }
    }

    suspend fun refreshOperations() {
        operationsOverview = container.mobileOperations.refreshOverview()
        notificationInbox = container.mobileOperations.notificationInbox()
        sensitiveActionSummary = container.mobileOperations.sensitiveActionQueueSummary()
    }

    suspend fun requestStepUpEnvelope(
        actionKind: MobileSensitiveActionKind,
        objectId: UUID,
        replayAttempt: Int? = null,
    ) = runCatching {
        val reasonKey = when (actionKind) {
            MobileSensitiveActionKind.APPROVAL_DECISION -> OPERATIONS_PASSKEY_APPROVAL_DECISION_REASON_KEY
            MobileSensitiveActionKind.POLL_VOTE -> OPERATIONS_PASSKEY_POLL_VOTE_REASON_KEY
            else -> error("unsupported mobile passkey step-up action: $actionKind")
        }
        check(reasonKey.isNotBlank())
        container.passkeyStepUp.requestStepUp(
            context = context,
            binding = container.mobileOperations.stepUpBinding(
                actionKind = actionKind,
                objectId = objectId,
                replayAttempt = replayAttempt,
            ),
        )
    }.getOrNull()

    LaunchedEffect(authenticated) {
        if (authenticated) {
            runCatching { container.workOrders.refreshToday() }
            runCatching { container.locationConsent.status() }
                .onSuccess { locationConsent = it }
                .onFailure { snackbarHostState.showSnackbar(locationConsentFailedMessage) }
        } else {
            locationConsent = null
            operationsOverview = null
            notificationInbox = MobileNotificationInbox(emptyList())
            sensitiveActionSummary = MobileSensitiveActionQueueSummary(emptyList())
        }
    }

    LaunchedEffect(selectedId) {
        selectedId?.let {
            runCatching { container.workOrders.refreshDetail(UUID.fromString(it)) }
        }
    }

    fun updateLocationConsent(block: suspend () -> LocationConsentStatus) {
        scope.launch {
            busy = true
            runCatching { block() }
                .onSuccess { locationConsent = it }
                .onFailure { snackbarHostState.showSnackbar(locationConsentFailedMessage) }
            busy = false
        }
    }

    if (showCamera && selected != null) {
        val uploadFailed = stringResource(R.string.operation_failed)
        val uploadSaved = stringResource(R.string.capture_saved)
        Scaffold(
            contentWindowInsets = WindowInsets.safeDrawing,
            snackbarHost = { SnackbarHost(snackbarHostState) },
        ) { padding ->
            Surface(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(padding),
                color = MaterialTheme.colorScheme.background,
            ) {
                Column(modifier = Modifier.fillMaxSize()) {
                    if (busy) {
                        LinearProgressIndicator(modifier = Modifier.fillMaxWidth())
                    }
                    LocationConsentControls(
                        status = locationConsent,
                        busy = busy,
                        onGrant = {
                            updateLocationConsent { container.locationConsent.grant() }
                        },
                        onSuspend = {
                            updateLocationConsent { container.locationConsent.suspend() }
                        },
                        onResume = {
                            updateLocationConsent { container.locationConsent.resume() }
                        },
                        onWithdraw = {
                            updateLocationConsent { container.locationConsent.withdraw() }
                        },
                    )
                    Box(
                        modifier = Modifier
                            .fillMaxWidth()
                            .weight(1f),
                    ) {
                        CameraCaptureScreen(
                            onCancel = { showCamera = false },
                            onCaptured = { file ->
                                scope.launch {
                                    busy = true
                                    runCatching {
                                        container.evidence.queueOrUpload(
                                            workOrderId = selected.id,
                                            stage = AttachmentStage.AFTER,
                                            file = file,
                                            contentType = "image/jpeg",
                                        )
                                    }.onSuccess {
                                        snackbarHostState.showSnackbar(uploadSaved)
                                    }.onFailure {
                                        snackbarHostState.showSnackbar(uploadFailed)
                                    }
                                    busy = false
                                    showCamera = false
                                }
                            },
                            onError = {
                                scope.launch { snackbarHostState.showSnackbar(uploadFailed) }
                            },
                        )
                    }
                }
            }
        }
        return
    }

    Scaffold(
        contentWindowInsets = WindowInsets.safeDrawing,
        snackbarHost = { SnackbarHost(snackbarHostState) },
    ) { padding ->
        Surface(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding),
            color = MaterialTheme.colorScheme.background,
        ) {
            if (!authenticated) {
                LoginScreen(
                    busy = busy,
                    onLogin = { userId ->
                        scope.launch {
                            busy = true
                            val state = container.auth.login(context, userId)
                            val authenticatedState = state as? LoginState.Authenticated
                            authenticated = authenticatedState != null
                            currentUserId = if (authenticated) userId else null
                            busy = false
                            if (authenticatedState?.deviceRegistration is DeviceRegistrationState.RetryPending) {
                                snackbarHostState.showSnackbar(deviceRegistrationRetryPendingMessage)
                            } else if (!authenticated) {
                                snackbarHostState.showSnackbar(loginFailedMessage)
                            }
                        }
                    },
                )
            } else if (selected != null) {
                WorkOrderDetailScreen(
                    order = selected,
                    busy = busy,
                    locationConsent = locationConsent,
                    onBack = { selectedId = null },
                    onLocationGrant = {
                        updateLocationConsent { container.locationConsent.grant() }
                    },
                    onLocationSuspend = {
                        updateLocationConsent { container.locationConsent.suspend() }
                    },
                    onLocationResume = {
                        updateLocationConsent { container.locationConsent.resume() }
                    },
                    onLocationWithdraw = {
                        updateLocationConsent { container.locationConsent.withdraw() }
                    },
                    onStart = {
                        scope.launch {
                            busy = true
                            runCatching { container.workOrders.start(selected.id) }
                                .onFailure { snackbarHostState.showSnackbar(offlineQueuedMessage) }
                            busy = false
                        }
                    },
                    onReport = { draft ->
                        scope.launch {
                            busy = true
                            runCatching { container.workOrders.submitReport(selected.id, draft) }
                                .onSuccess { snackbarHostState.showSnackbar(reportSubmittedMessage) }
                                .onFailure { snackbarHostState.showSnackbar(offlineQueuedMessage) }
                            busy = false
                        }
                    },
                    onCaptureEvidence = {
                        showCamera = true
                    },
                    onCameraPermissionNeeded = { showCamera = true },
                    onCameraPermissionDenied = {
                        scope.launch {
                            snackbarHostState.showSnackbar(cameraPermissionDeniedMessage)
                        }
                    },
                )
            } else {
                Column(modifier = Modifier.fillMaxSize()) {
                    FieldTabRow(
                        selectedTab = selectedTab,
                        onSelect = { selectedTab = it },
                    )
                    if (selectedTab == 0) {
                        TodayScreen(
                            orders = orders,
                            busy = busy,
                            locationConsent = locationConsent,
                            modifier = Modifier.weight(1f),
                            onRefresh = {
                                scope.launch {
                                    busy = true
                                    runCatching {
                                        container.offlineQueue.replayPending()
                                        container.evidence.uploadPending()
                                        container.messenger.replayPending()
                                        container.workOrders.refreshToday()
                                        locationConsent = container.locationConsent.status()
                                    }.onFailure {
                                        snackbarHostState.showSnackbar(operationFailedMessage)
                                    }
                                    busy = false
                                }
                            },
                            onLogout = {
                                container.auth.clearSession()
                                authenticated = false
                                currentUserId = null
                                selectedId = null
                                messengerState = MessengerState()
                                locationConsent = null
                                operationsOverview = null
                                approvalComment = ""
                                notificationInbox = MobileNotificationInbox(emptyList())
                                sensitiveActionSummary = MobileSensitiveActionQueueSummary(emptyList())
                            },
                            onLocationGrant = {
                                updateLocationConsent { container.locationConsent.grant() }
                            },
                            onLocationSuspend = {
                                updateLocationConsent { container.locationConsent.suspend() }
                            },
                            onLocationResume = {
                                updateLocationConsent { container.locationConsent.resume() }
                            },
                            onLocationWithdraw = {
                                updateLocationConsent { container.locationConsent.withdraw() }
                            },
                            onSelect = { selectedId = it.id.toString() },
                        )
                    } else if (selectedTab == 1) {
                        WorkHubScreen(
                            summary = WorkHubSummary.build(
                                today = orders,
                                messengerState = messengerState,
                                gpsMayCollect = locationConsent?.mayCollect == true,
                            ),
                            busy = busy,
                            modifier = Modifier.weight(1f),
                            onRefresh = {
                                scope.launch {
                                    busy = true
                                    runCatching {
                                        container.offlineQueue.replayPending()
                                        container.evidence.uploadPending()
                                        container.messenger.replayPending()
                                        container.workOrders.refreshToday()
                                        refreshMessenger()
                                        locationConsent = container.locationConsent.status()
                                    }.onFailure {
                                        snackbarHostState.showSnackbar(operationFailedMessage)
                                    }
                                    busy = false
                                }
                            },
                        )
                    } else if (selectedTab == 2) {
                        MessengerScreen(
                            state = messengerState,
                            busy = busy,
                            currentUserId = currentUserId,
                            workOrderRequestNosById = orders.associate { it.id to it.requestNo },
                            searchQuery = messengerSearchQuery,
                            draft = messengerDraft,
                            modifier = Modifier.weight(1f),
                            onSearchQueryChange = { messengerSearchQuery = it },
                            onDraftChange = { messengerDraft = it },
                            onRefresh = {
                                scope.launch {
                                    busy = true
                                    runCatching { refreshMessenger() }
                                        .onFailure { snackbarHostState.showSnackbar(operationFailedMessage) }
                                    busy = false
                                }
                            },
                            onSelectThread = { thread ->
                                scope.launch {
                                    busy = true
                                    runCatching {
                                        messengerState = messengerReducer.reduce(
                                            messengerState,
                                            MessengerAction.ThreadSelected(thread.id),
                                        )
                                        loadMessengerMessages(thread.id)
                                    }.onFailure { snackbarHostState.showSnackbar(operationFailedMessage) }
                                    busy = false
                                }
                            },
                            onLoadOlder = {
                                val threadId = messengerState.selectedThreadId
                                if (threadId != null) {
                                    scope.launch {
                                        busy = true
                                        runCatching {
                                            loadMessengerMessages(
                                                threadId,
                                                messengerState.nextCursorByThread[threadId],
                                            )
                                        }.onFailure { snackbarHostState.showSnackbar(operationFailedMessage) }
                                        busy = false
                                    }
                                }
                            },
                            onSearch = {
                                val query = messengerSearchQuery.trim()
                                scope.launch {
                                    busy = true
                                    runCatching {
                                        val messages = if (query.isBlank()) {
                                            emptyList()
                                        } else {
                                            container.messenger.search(query)
                                        }
                                        messengerState = messengerReducer.reduce(
                                            messengerState,
                                            MessengerAction.SearchResultsLoaded(messages),
                                        )
                                    }.onFailure { snackbarHostState.showSnackbar(operationFailedMessage) }
                                    busy = false
                                }
                            },
                            onSend = {
                                val threadId = messengerState.selectedThreadId
                                val body = messengerDraft.trim()
                                if (threadId != null && body.isNotEmpty()) {
                                    scope.launch {
                                        busy = true
                                        runCatching {
                                            val result = container.messenger.sendOrQueue(
                                                threadId = threadId,
                                                body = body,
                                                attachmentEvidenceIds = emptyList(),
                                            )
                                            messengerDraft = ""
                                            if (result.state == MessengerSendState.PENDING) {
                                                snackbarHostState.showSnackbar(messengerSendPendingMessage)
                                            }
                                            result.message?.let { message ->
                                                messengerState = messengerReducer.reduce(
                                                    messengerState,
                                                    MessengerAction.MessageSent(message),
                                                )
                                                runCatching { container.messenger.markRead(threadId, message.id) }
                                            }
                                        }.onFailure {
                                            snackbarHostState.showSnackbar(messengerSendPendingMessage)
                                        }
                                        busy = false
                                    }
                                }
                            },
                        )
                    } else {
                        OperationsScreen(
                            dashboard = operationsOverview?.snapshot?.let(::MobileOperationsDashboard),
                            origin = operationsOverview?.origin,
                            notificationInbox = notificationInbox,
                            sensitiveActionSummary = sensitiveActionSummary,
                            busy = busy,
                            approvalComment = approvalComment,
                            modifier = Modifier.weight(1f),
                            onApprovalCommentChange = { approvalComment = it },
                            onRefresh = {
                                scope.launch {
                                    busy = true
                                    runCatching { refreshOperations() }
                                        .onFailure { snackbarHostState.showSnackbar(operationFailedMessage) }
                                    busy = false
                                }
                            },
                            onQueueApproval = {
                                val approval = operationsOverview?.snapshot?.let(::MobileOperationsDashboard)?.approvals
                                    ?.firstOrNull { it.canExecuteOnMobile }
                                if (approval != null) {
                                    scope.launch {
                                        busy = true
                                        runCatching {
                                            container.mobileOperations.approveWorkOrder(
                                                approval = approval,
                                                comment = approvalComment,
                                                stepUp = requestStepUpEnvelope(
                                                    actionKind = MobileSensitiveActionKind.APPROVAL_DECISION,
                                                    objectId = approval.sourceId,
                                                ),
                                            )?.let { snackbarHostState.showSnackbar(operationsPasskeyRequiredMessage) }
                                            sensitiveActionSummary = container.mobileOperations.sensitiveActionQueueSummary()
                                        }.onFailure { snackbarHostState.showSnackbar(operationFailedMessage) }
                                        busy = false
                                    }
                                }
                            },
                            onReplaySensitiveActions = {
                                scope.launch {
                                    busy = true
                                    runCatching {
                                        container.mobileOperations.replaySensitiveActions { _, binding ->
                                            runCatching {
                                                container.passkeyStepUp.requestStepUp(
                                                    context = context,
                                                    binding = binding,
                                                )
                                            }.getOrNull()
                                        }
                                        sensitiveActionSummary = container.mobileOperations.sensitiveActionQueueSummary()
                                    }.onFailure { snackbarHostState.showSnackbar(operationFailedMessage) }
                                    busy = false
                                }
                            },
                            onMarkNotificationRead = { notification ->
                                scope.launch {
                                    notificationInbox = container.mobileOperations.markNotificationRead(notification.id)
                                }
                            },
                            onMarkThreadRead = { thread ->
                                scope.launch {
                                    busy = true
                                    runCatching {
                                        operationsOverview = container.mobileOperations.markMailThreadSeen(thread.id, true)
                                            ?: operationsOverview
                                    }.onFailure { snackbarHostState.showSnackbar(operationFailedMessage) }
                                    busy = false
                                }
                            },
                            onVotePoll = { poll ->
                                val optionId = poll.firstOptionId
                                if (poll.canVote && optionId != null) {
                                    scope.launch {
                                        busy = true
                                        runCatching {
                                            val queued = container.mobileOperations.votePoll(
                                                poll.id,
                                                listOf(optionId),
                                                requestStepUpEnvelope(
                                                    actionKind = MobileSensitiveActionKind.POLL_VOTE,
                                                    objectId = poll.id,
                                                ),
                                            )
                                            sensitiveActionSummary = container.mobileOperations.sensitiveActionQueueSummary()
                                            if (queued == null) {
                                                operationsOverview = container.mobileOperations.cachedOverview()?.copy(
                                                    origin = MobileOperationsSnapshotOrigin.LIVE,
                                                )
                                                snackbarHostState.showSnackbar(operationsPollVotedMessage)
                                            } else {
                                                snackbarHostState.showSnackbar(operationsPasskeyRequiredMessage)
                                            }
                                        }.onFailure { snackbarHostState.showSnackbar(operationFailedMessage) }
                                        busy = false
                                    }
                                }
                            },
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun FieldTabRow(
    selectedTab: Int,
    onSelect: (Int) -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 12.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        FilterChip(
            selected = selectedTab == 0,
            onClick = { onSelect(0) },
            label = { Text(stringResource(R.string.today_title)) },
        )
        FilterChip(
            selected = selectedTab == 1,
            onClick = { onSelect(1) },
            label = { Text(stringResource(R.string.work_hub_title)) },
        )
        FilterChip(
            selected = selectedTab == 2,
            onClick = { onSelect(2) },
            label = { Text(stringResource(R.string.messenger_title)) },
        )
        FilterChip(
            selected = selectedTab == 3,
            onClick = { onSelect(3) },
            label = { Text(stringResource(R.string.operations_title)) },
        )
    }
}


@Composable
internal fun WorkHubScreen(
    summary: WorkHubSummary,
    busy: Boolean,
    onRefresh: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(modifier = modifier.fillMaxSize()) {
        if (busy) {
            LinearProgressIndicator(modifier = Modifier.fillMaxWidth())
        }
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 16.dp, vertical = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                text = stringResource(R.string.work_hub_title),
                style = MaterialTheme.typography.titleLarge,
                modifier = Modifier.weight(1f),
            )
            OutlinedButton(
                onClick = onRefresh,
                enabled = !busy,
                modifier = Modifier.heightIn(min = 48.dp),
            ) {
                Text(stringResource(R.string.refresh))
            }
        }
        LazyColumn(
            contentPadding = PaddingValues(horizontal = 12.dp, vertical = 8.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            item {
                WorkHubCard(title = stringResource(R.string.work_hub_daily_section)) {
                    Text(stringResource(R.string.work_hub_today_count_format, summary.todayWorkCount))
                    Text(stringResource(R.string.work_hub_urgent_count_format, summary.urgentWorkCount))
                    Text(stringResource(R.string.work_hub_target_due_count_format, summary.targetDueWorkCount))
                    Text(stringResource(R.string.location_consent_collection_format, stringResource(if (summary.gpsMayCollect) R.string.yes else R.string.no)))
                    Text(stringResource(R.string.work_hub_daily_footer), style = MaterialTheme.typography.bodySmall)
                }
            }
            item {
                WorkHubCard(title = stringResource(R.string.work_hub_sensitive_section)) {
                    Text(stringResource(R.string.work_hub_approval_count_format, summary.approvalRelatedCount))
                    Text(stringResource(R.string.work_hub_pending_sync_format, summary.pendingSyncCount))
                    Text(stringResource(R.string.work_hub_passkey_required), style = MaterialTheme.typography.titleSmall)
                    Text(stringResource(R.string.work_hub_sensitive_note), style = MaterialTheme.typography.bodySmall)
                }
            }
            item {
                WorkHubCard(title = stringResource(R.string.work_hub_collaboration_section)) {
                    summary.collaborationActions.forEach { action ->
                        WorkHubActionRow(action = action)
                    }
                    Text(stringResource(R.string.work_hub_collaboration_footer), style = MaterialTheme.typography.bodySmall)
                }
            }
        }
    }
}

@Composable
private fun WorkHubActionRow(action: MobileCollaborationAction) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.Top,
    ) {
        Column(
            modifier = Modifier.weight(1f),
            verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            Text(text = stringResource(action.titleRes), style = MaterialTheme.typography.titleSmall)
            val valueText = action.count?.let { stringResource(action.valueRes, it) }
                ?: stringResource(action.valueRes)
            Text(text = valueText, style = MaterialTheme.typography.bodyMedium)
            Text(text = stringResource(action.detailRes), style = MaterialTheme.typography.bodySmall)
            if (action.requiresPasskey) {
                Text(
                    text = stringResource(R.string.work_hub_action_passkey_step_up),
                    style = MaterialTheme.typography.labelMedium,
                )
            }
        }
        AssistChip(
            onClick = {},
            enabled = false,
            label = { Text(stringResource(action.status.labelRes)) },
        )
    }
}

@Composable
private fun WorkHubCard(
    title: String,
    content: @Composable ColumnScope.() -> Unit,
) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        shape = MaterialTheme.shapes.small,
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
    ) {
        Column(
            modifier = Modifier.padding(14.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Text(text = title, style = MaterialTheme.typography.titleMedium)
            content()
        }
    }
}


@Composable
internal fun OperationsScreen(
    dashboard: MobileOperationsDashboard?,
    origin: MobileOperationsSnapshotOrigin?,
    busy: Boolean,
    approvalComment: String,
    onApprovalCommentChange: (String) -> Unit,
    onRefresh: () -> Unit,
    onQueueApproval: () -> Unit,
    onMarkThreadRead: (MobileMailThreadRow) -> Unit,
    onVotePoll: (MobilePollRow) -> Unit,
    modifier: Modifier = Modifier,
    notificationInbox: MobileNotificationInbox = MobileNotificationInbox(emptyList()),
    sensitiveActionSummary: MobileSensitiveActionQueueSummary = MobileSensitiveActionQueueSummary(emptyList()),
    onReplaySensitiveActions: () -> Unit = {},
    onMarkNotificationRead: (MobileRoutedNotification) -> Unit = {},
) {
    LaunchedEffect(Unit) {
        if (dashboard == null) {
            onRefresh()
        }
    }

    Column(modifier = modifier.fillMaxSize()) {
        if (busy) {
            LinearProgressIndicator(modifier = Modifier.fillMaxWidth())
        }
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 16.dp, vertical = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                text = stringResource(R.string.operations_title),
                style = MaterialTheme.typography.titleLarge,
                modifier = Modifier.weight(1f),
            )
            OutlinedButton(
                onClick = onRefresh,
                enabled = !busy,
                modifier = Modifier.heightIn(min = 48.dp),
            ) {
                Text(stringResource(R.string.refresh))
            }
        }

        LazyColumn(
            contentPadding = PaddingValues(horizontal = 12.dp, vertical = 8.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            if (origin == MobileOperationsSnapshotOrigin.CACHED_AFTER_FAILURE) {
                item { OperationsCard(title = stringResource(R.string.operations_cached_title)) { Text(stringResource(R.string.operations_cached_fallback)) } }
            }
            item {
                OperationsCard(title = stringResource(R.string.operations_notification_section)) {
                    Text(stringResource(R.string.operations_notification_badge_format, notificationInbox.badgeCount))
                    Text(stringResource(R.string.operations_notification_unread_format, notificationInbox.unreadCount))
                    Text(stringResource(R.string.operations_notification_urgent_format, notificationInbox.urgentUnreadCount))
                    notificationInbox.notifications.take(3).forEach { notification ->
                        OperationsNotificationRow(notification = notification, onMarkRead = { onMarkNotificationRead(notification) })
                    }
                }
            }
            item {
                OperationsCard(title = stringResource(R.string.operations_approval_section)) {
                    Text(stringResource(R.string.operations_approval_count_format, dashboard?.approvalCount ?: 0))
                    val approvals = dashboard?.approvals.orEmpty()
                    if (approvals.isEmpty()) {
                        Text(stringResource(R.string.operations_approval_empty), style = MaterialTheme.typography.bodySmall)
                    } else {
                        approvals.take(3).forEach {
                            Text(it.title, style = MaterialTheme.typography.bodyMedium)
                            Text(it.summary, style = MaterialTheme.typography.bodySmall)
                            if (!it.canExecuteOnMobile) {
                                Text(stringResource(R.string.operations_approval_unsupported_mobile), style = MaterialTheme.typography.labelMedium)
                            }
                        }
                    }
                    OutlinedTextField(
                        value = approvalComment,
                        onValueChange = onApprovalCommentChange,
                        label = { Text(stringResource(R.string.operations_approval_comment)) },
                        minLines = 2,
                        modifier = Modifier.fillMaxWidth(),
                    )
                    Button(
                        onClick = onQueueApproval,
                        enabled = !busy,
                        modifier = Modifier.heightIn(min = 48.dp),
                    ) {
                        Text(stringResource(R.string.operations_queue_approval))
                    }
                    OutlinedButton(
                        onClick = onReplaySensitiveActions,
                        enabled = !busy,
                        modifier = Modifier.heightIn(min = 48.dp),
                    ) {
                        Text(stringResource(R.string.operations_replay_sensitive_actions))
                    }
                }
            }
            item {
                OperationsCard(title = stringResource(R.string.operations_sensitive_section)) {
                    Text(stringResource(R.string.operations_sensitive_waiting_passkey_format, sensitiveActionSummary.pendingPasskeyCount))
                    Text(stringResource(R.string.operations_sensitive_ready_replay_format, sensitiveActionSummary.readyForReplayCount))
                    Text(stringResource(R.string.operations_sensitive_failed_format, sensitiveActionSummary.failedCount))
                }
            }
            item {
                OperationsCard(title = stringResource(R.string.operations_mail_section)) {
                    Text(stringResource(R.string.operations_mail_unread_format, dashboard?.unreadMailCount ?: 0))
                    val threads = dashboard?.mailThreads.orEmpty()
                    if (threads.isEmpty()) {
                        Text(stringResource(R.string.operations_mail_empty), style = MaterialTheme.typography.bodySmall)
                    } else {
                        threads.forEach { thread ->
                            OperationsMailThreadRow(thread = thread, onMarkRead = { onMarkThreadRead(thread) })
                        }
                    }
                }
            }
            item {
                OperationsCard(title = stringResource(R.string.operations_calendar_section)) {
                    val events = dashboard?.calendarEvents.orEmpty()
                    if (events.isEmpty()) {
                        Text(stringResource(R.string.operations_calendar_empty), style = MaterialTheme.typography.bodySmall)
                    } else {
                        events.forEach { OperationsCalendarEventRow(event = it) }
                    }
                }
            }
            item {
                OperationsCard(title = stringResource(R.string.operations_poll_section)) {
                    val polls = dashboard?.polls.orEmpty()
                    if (polls.isEmpty()) {
                        Text(stringResource(R.string.operations_poll_empty), style = MaterialTheme.typography.bodySmall)
                    } else {
                        polls.forEach { poll -> OperationsPollRow(poll = poll, onVote = { onVotePoll(poll) }) }
                    }
                }
            }
        }
    }
}

@Composable
private fun OperationsMailThreadRow(thread: MobileMailThreadRow, onMarkRead: () -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(4.dp), modifier = Modifier.fillMaxWidth()) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(thread.subject, style = MaterialTheme.typography.titleSmall, modifier = Modifier.weight(1f))
            if (thread.unreadCount > 0) AssistChip(onClick = {}, enabled = false, label = { Text(stringResource(R.string.operations_unread_chip)) })
        }
        Text(messengerTimestampFormatter.format(thread.lastMessageAt), style = MaterialTheme.typography.bodySmall)
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(stringResource(R.string.operations_mail_thread_unread_format, thread.unreadCount), style = MaterialTheme.typography.bodySmall)
            if (thread.hasAttachments) Text(stringResource(R.string.operations_attachment_chip), style = MaterialTheme.typography.labelMedium)
            if (thread.isFlagged) Text(stringResource(R.string.operations_flagged_chip), style = MaterialTheme.typography.labelMedium)
        }
        OutlinedButton(onClick = onMarkRead, enabled = thread.unreadCount > 0, modifier = Modifier.heightIn(min = 48.dp)) {
            Text(stringResource(R.string.operations_mark_read))
        }
    }
}

@Composable
private fun OperationsNotificationRow(notification: MobileRoutedNotification, onMarkRead: () -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(4.dp), modifier = Modifier.fillMaxWidth()) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(notification.title, style = MaterialTheme.typography.titleSmall, modifier = Modifier.weight(1f))
            AssistChip(
                onClick = {},
                enabled = false,
                label = {
                    Text(
                        stringResource(
                            if (notification.isUrgent) {
                                R.string.operations_notification_urgent_chip
                            } else {
                                R.string.operations_notification_normal_chip
                            },
                        ),
                    )
                },
            )
        }
        Text(notification.body, style = MaterialTheme.typography.bodyMedium)
        Text(messengerTimestampFormatter.format(notification.receivedAt), style = MaterialTheme.typography.bodySmall)
        OutlinedButton(onClick = onMarkRead, enabled = notification.isUnread, modifier = Modifier.heightIn(min = 48.dp)) {
            Text(stringResource(R.string.operations_notification_mark_read))
        }
    }
}

@Composable
private fun OperationsCalendarEventRow(event: MobileCalendarEventRow) {
    Column(verticalArrangement = Arrangement.spacedBy(4.dp), modifier = Modifier.fillMaxWidth()) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(event.title, style = MaterialTheme.typography.titleSmall, modifier = Modifier.weight(1f))
            AssistChip(onClick = {}, enabled = false, label = { Text(stringResource(scopeLabel(event.scopeType))) })
        }
        Text(event.description, style = MaterialTheme.typography.bodyMedium)
        Text(
            stringResource(
                R.string.operations_calendar_time_format,
                messengerTimestampFormatter.format(event.startsAt),
                messengerTimestampFormatter.format(event.endsAt),
            ),
            style = MaterialTheme.typography.bodySmall,
        )
        event.objectType?.let { Text(stringResource(R.string.operations_object_link_format, it), style = MaterialTheme.typography.bodySmall) }
    }
}

@Composable
private fun OperationsPollRow(poll: MobilePollRow, onVote: () -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(4.dp), modifier = Modifier.fillMaxWidth()) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(poll.title, style = MaterialTheme.typography.titleSmall, modifier = Modifier.weight(1f))
            AssistChip(onClick = {}, enabled = false, label = { Text(stringResource(pollStatusLabel(poll.status))) })
        }
        Text(poll.question, style = MaterialTheme.typography.bodyMedium)
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(stringResource(pollAnonymityLabel(poll.anonymity)), style = MaterialTheme.typography.labelMedium)
            Text(stringResource(R.string.operations_poll_vote_count_format, poll.voteCount), style = MaterialTheme.typography.labelMedium)
        }
        poll.firstOptionLabel?.let { option ->
            Button(onClick = onVote, enabled = poll.canVote, modifier = Modifier.heightIn(min = 48.dp)) {
                Text(stringResource(R.string.operations_poll_vote_option_format, option))
            }
        }
        if (poll.hasSubmittedVote) {
            Text(stringResource(R.string.operations_poll_submitted), style = MaterialTheme.typography.bodySmall)
        }
    }
}

@Composable
private fun OperationsCard(title: String, content: @Composable ColumnScope.() -> Unit) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        shape = MaterialTheme.shapes.small,
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
    ) {
        Column(modifier = Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(text = title, style = MaterialTheme.typography.titleMedium)
            content()
        }
    }
}

@StringRes
private fun scopeLabel(scope: CollaborationScopeType): Int = when (scope) {
    CollaborationScopeType.TENANT -> R.string.operations_scope_tenant
    CollaborationScopeType.ORG -> R.string.operations_scope_org
    CollaborationScopeType.DEPARTMENT -> R.string.operations_scope_department
    CollaborationScopeType.TEAM -> R.string.operations_scope_team
    CollaborationScopeType.PERSONAL -> R.string.operations_scope_personal
}

@StringRes
private fun pollStatusLabel(status: PollStatus): Int = when (status) {
    PollStatus.DRAFT -> R.string.operations_poll_status_draft
    PollStatus.OPEN -> R.string.operations_poll_status_open
    PollStatus.CLOSED -> R.string.operations_poll_status_closed
    PollStatus.ARCHIVED -> R.string.operations_poll_status_archived
}

@StringRes
private fun pollAnonymityLabel(anonymity: PollAnonymity): Int = when (anonymity) {
    PollAnonymity.NAMED -> R.string.operations_poll_named
    PollAnonymity.ANONYMOUS -> R.string.operations_poll_anonymous
}

@Composable
internal fun LoginScreen(
    busy: Boolean,
    onLogin: (UUID) -> Unit,
) {
    var userIdText by rememberSaveable(stateSaver = TextFieldValue.Saver) {
        mutableStateOf(TextFieldValue())
    }
    var showRequired by rememberSaveable { mutableStateOf(false) }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(20.dp),
        verticalArrangement = Arrangement.Center,
    ) {
        Text(
            text = stringResource(R.string.login_title),
            style = MaterialTheme.typography.headlineMedium,
        )
        Spacer(Modifier.height(20.dp))
        OutlinedTextField(
            value = userIdText,
            onValueChange = {
                userIdText = it
                showRequired = false
            },
            label = { Text(stringResource(R.string.login_user_id_label)) },
            supportingText = {
                if (showRequired) {
                    Text(stringResource(R.string.error_required))
                }
            },
            isError = showRequired,
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
        )
        Spacer(Modifier.height(16.dp))
        Button(
            onClick = {
                val userId = runCatching { UUID.fromString(userIdText.text.trim()) }.getOrNull()
                if (userId == null) {
                    showRequired = true
                } else {
                    onLogin(userId)
                }
            },
            enabled = !busy,
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = 48.dp),
        ) {
            Text(stringResource(if (busy) R.string.loading else R.string.login_button))
        }
    }
}

@Composable
internal fun TodayScreen(
    orders: List<TechnicianWorkOrder>,
    busy: Boolean,
    locationConsent: LocationConsentStatus?,
    onRefresh: () -> Unit,
    onLogout: () -> Unit,
    onLocationGrant: () -> Unit,
    onLocationSuspend: () -> Unit,
    onLocationResume: () -> Unit,
    onLocationWithdraw: () -> Unit,
    onSelect: (TechnicianWorkOrder) -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier = modifier.fillMaxSize(),
    ) {
        if (busy) {
            LinearProgressIndicator(modifier = Modifier.fillMaxWidth())
        }
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 16.dp, vertical = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                text = stringResource(R.string.today_title),
                style = MaterialTheme.typography.titleLarge,
                modifier = Modifier.weight(1f),
            )
            OutlinedButton(
                onClick = onRefresh,
                enabled = !busy,
                modifier = Modifier.heightIn(min = 48.dp),
            ) {
                Text(stringResource(R.string.refresh))
            }
            Spacer(Modifier.width(8.dp))
            OutlinedButton(
                onClick = onLogout,
                modifier = Modifier.heightIn(min = 48.dp),
            ) {
                Text(stringResource(R.string.logout))
            }
        }
        LocationConsentControls(
            status = locationConsent,
            busy = busy,
            onGrant = onLocationGrant,
            onSuspend = onLocationSuspend,
            onResume = onLocationResume,
            onWithdraw = onLocationWithdraw,
        )

        if (orders.isEmpty()) {
            Column(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(20.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.Center,
            ) {
                Text(
                    text = stringResource(R.string.empty_today),
                    style = MaterialTheme.typography.bodyLarge,
                )
            }
        } else {
            LazyColumn(
                contentPadding = PaddingValues(horizontal = 12.dp, vertical = 8.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                items(orders, key = { it.id }) { order ->
                    WorkOrderRow(order = order, onClick = { onSelect(order) })
                }
            }
        }
    }
}

@Composable
internal fun MessengerScreen(
    state: MessengerState,
    busy: Boolean,
    searchQuery: String,
    draft: String,
    onSearchQueryChange: (String) -> Unit,
    onDraftChange: (String) -> Unit,
    onRefresh: () -> Unit,
    onSelectThread: (MessengerThread) -> Unit,
    onLoadOlder: () -> Unit,
    onSearch: () -> Unit,
    onSend: () -> Unit,
    modifier: Modifier = Modifier,
    currentUserId: UUID? = null,
    workOrderRequestNosById: Map<UUID, String> = emptyMap(),
) {
    LaunchedEffect(Unit) {
        if (state.threads.isEmpty()) {
            onRefresh()
        }
    }

    Column(modifier = modifier.fillMaxSize()) {
        if (busy) {
            LinearProgressIndicator(modifier = Modifier.fillMaxWidth())
        }
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 16.dp, vertical = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                text = stringResource(R.string.messenger_title),
                style = MaterialTheme.typography.titleLarge,
                modifier = Modifier.weight(1f),
            )
            OutlinedButton(
                onClick = onRefresh,
                enabled = !busy,
                modifier = Modifier.heightIn(min = 48.dp),
            ) {
                Text(stringResource(R.string.refresh))
            }
        }

        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 16.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            OutlinedTextField(
                value = searchQuery,
                onValueChange = onSearchQueryChange,
                label = { Text(stringResource(R.string.messenger_search)) },
                singleLine = true,
                modifier = Modifier.weight(1f),
            )
            Button(
                onClick = onSearch,
                enabled = !busy,
                modifier = Modifier.heightIn(min = 48.dp),
            ) {
                Text(stringResource(R.string.messenger_search_button))
            }
        }

        LazyColumn(
            contentPadding = PaddingValues(horizontal = 12.dp, vertical = 8.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
            modifier = Modifier.weight(1f),
        ) {
            if (state.searchResults.isNotEmpty()) {
                items(state.searchResults, key = { it.id }) { message ->
                    MessengerMessageRow(message = message, currentUserId = currentUserId)
                }
            }
            item {
                Text(
                    text = stringResource(R.string.messenger_threads),
                    style = MaterialTheme.typography.titleMedium,
                    modifier = Modifier.padding(top = 8.dp, bottom = 4.dp),
                )
            }
            if (state.threads.isEmpty()) {
                item {
                    Text(
                        text = stringResource(R.string.messenger_empty_threads),
                        style = MaterialTheme.typography.bodyMedium,
                        modifier = Modifier.padding(12.dp),
                    )
                }
            }
            items(state.threads, key = { it.id }) { thread ->
                MessengerThreadRow(
                    thread = thread,
                    selected = state.selectedThreadId == thread.id,
                    workOrderRequestNosById = workOrderRequestNosById,
                    onClick = { onSelectThread(thread) },
                )
            }
            item {
                Text(
                    text = stringResource(R.string.messenger_messages),
                    style = MaterialTheme.typography.titleMedium,
                    modifier = Modifier.padding(top = 12.dp, bottom = 4.dp),
                )
            }
            val selectedThreadId = state.selectedThreadId
            val messages = selectedThreadId?.let { state.messagesByThread[it].orEmpty() }.orEmpty()
            if (selectedThreadId == null) {
                item {
                    Text(
                        text = stringResource(R.string.messenger_select_thread),
                        style = MaterialTheme.typography.bodyMedium,
                        modifier = Modifier.padding(12.dp),
                    )
                }
            } else {
                if (state.nextCursorByThread[selectedThreadId] != null) {
                    item {
                        OutlinedButton(
                            onClick = onLoadOlder,
                            enabled = !busy,
                            modifier = Modifier.fillMaxWidth(),
                        ) {
                            Text(stringResource(R.string.messenger_load_older))
                        }
                    }
                }
                if (messages.isEmpty()) {
                    item {
                        Text(
                            text = stringResource(R.string.messenger_empty_messages),
                            style = MaterialTheme.typography.bodyMedium,
                            modifier = Modifier.padding(12.dp),
                        )
                    }
                }
                items(messages, key = { it.id }) { message ->
                    MessengerMessageRow(message = message, currentUserId = currentUserId)
                }
            }
        }

        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(12.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            OutlinedTextField(
                value = draft,
                onValueChange = onDraftChange,
                label = { Text(stringResource(R.string.messenger_composer)) },
                minLines = 1,
                maxLines = 4,
                modifier = Modifier.weight(1f),
            )
            Button(
                onClick = onSend,
                enabled = !busy && state.selectedThreadId != null,
                modifier = Modifier.heightIn(min = 48.dp),
            ) {
                Text(stringResource(R.string.messenger_send))
            }
        }
    }
}

@Composable
private fun MessengerThreadRow(
    thread: MessengerThread,
    selected: Boolean,
    workOrderRequestNosById: Map<UUID, String>,
    onClick: () -> Unit,
) {
    Card(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick),
        shape = MaterialTheme.shapes.small,
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
    ) {
        Column(
            modifier = Modifier.padding(14.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    text = messengerThreadTitleSpec(
                        thread = thread,
                        workOrderRequestNosById = workOrderRequestNosById,
                    ).localizedText(),
                    style = MaterialTheme.typography.titleMedium,
                    modifier = Modifier.weight(1f),
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                AssistChip(
                    onClick = {},
                    label = { Text(stringResource(thread.kind.labelRes())) },
                )
            }
            Text(
                text = stringResource(R.string.messenger_member_count_format, thread.memberCount),
                style = MaterialTheme.typography.bodySmall,
            )
            if (selected) {
                Text(
                    text = stringResource(R.string.messenger_selected),
                    style = MaterialTheme.typography.labelSmall,
                )
            }
        }
    }
}

internal sealed interface MessengerThreadTitleSpec {
    data class RuntimeData(val text: String) : MessengerThreadTitleSpec
    data class Localized(@get:StringRes val resId: Int, val formatArg: String? = null) : MessengerThreadTitleSpec
}

internal fun messengerThreadTitleSpec(
    thread: MessengerThread,
    workOrderRequestNosById: Map<UUID, String> = emptyMap(),
): MessengerThreadTitleSpec {
    thread.title?.takeIf { it.isNotBlank() }?.let { return MessengerThreadTitleSpec.RuntimeData(it) }

    return when (thread.kind) {
        MessengerThreadKind.WORK_ORDER -> {
            val requestNo = thread.workOrderId
                ?.let(workOrderRequestNosById::get)
                ?.takeIf { it.isNotBlank() }
            if (requestNo != null) {
                MessengerThreadTitleSpec.Localized(R.string.messenger_thread_work_order_format, requestNo)
            } else {
                MessengerThreadTitleSpec.Localized(R.string.messenger_thread_work_order)
            }
        }
        MessengerThreadKind.TEAM -> MessengerThreadTitleSpec.Localized(R.string.messenger_thread_team)
        MessengerThreadKind.DM -> MessengerThreadTitleSpec.Localized(R.string.messenger_thread_dm)
        MessengerThreadKind.GROUP -> MessengerThreadTitleSpec.Localized(R.string.messenger_thread_group)
    }
}

@Composable
private fun MessengerThreadTitleSpec.localizedText(): String = when (this) {
    is MessengerThreadTitleSpec.RuntimeData -> text
    is MessengerThreadTitleSpec.Localized -> formatArg?.let { stringResource(resId, it) }
        ?: stringResource(resId)
}

@Composable
private fun MessengerMessageRow(message: MessengerMessage, currentUserId: UUID?) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        shape = MaterialTheme.shapes.small,
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
    ) {
        val showReadProgress = currentUserId == message.senderId && message.readTargetCount > 0
        Column(
            modifier = Modifier.padding(14.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            if (showReadProgress) {
                AssistChip(
                    onClick = {},
                    label = {
                        Text(stringResource(R.string.messenger_read_progress_format, message.readCount, message.readTargetCount))
                    },
                )
            }
            Text(
                text = message.body,
                style = MaterialTheme.typography.bodyMedium,
            )
            Row(
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    text = message.sentAt.format(messengerTimestampFormatter),
                    style = MaterialTheme.typography.bodySmall,
                )
                if (message.attachmentEvidenceIds.isNotEmpty()) {
                    AssistChip(
                        onClick = {},
                        label = { Text(stringResource(R.string.messenger_attachment)) },
                    )
                }
            }
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun WorkOrderRow(
    order: TechnicianWorkOrder,
    onClick: () -> Unit,
) {
    Card(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick),
        shape = MaterialTheme.shapes.small,
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
    ) {
        Column(
            modifier = Modifier.padding(14.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    text = order.requestNo,
                    style = MaterialTheme.typography.titleMedium,
                    modifier = Modifier.weight(1f),
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                AssistChip(
                    onClick = {},
                    label = { Text(stringResource(order.priority.labelRes())) },
                )
            }
            Text(
                text = stringResource(R.string.equipment_format, order.managementNo, order.modelName),
                style = MaterialTheme.typography.bodyMedium,
            )
            Text(
                text = stringResource(R.string.site_format, order.customerName, order.siteName),
                style = MaterialTheme.typography.bodyMedium,
            )
            FlowRow(
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                AssistChip(
                    onClick = {},
                    label = { Text(stringResource(order.status.labelRes())) },
                )
                AssistChip(
                    onClick = {},
                    label = { Text(stringResource(order.syncState.labelRes())) },
                )
            }
        }
    }
}

@OptIn(ExperimentalLayoutApi::class, ExperimentalMaterial3Api::class)
@Composable
internal fun WorkOrderDetailScreen(
    order: TechnicianWorkOrder,
    busy: Boolean,
    locationConsent: LocationConsentStatus?,
    onBack: () -> Unit,
    onLocationGrant: () -> Unit,
    onLocationSuspend: () -> Unit,
    onLocationResume: () -> Unit,
    onLocationWithdraw: () -> Unit,
    onStart: () -> Unit,
    onReport: (ReportDraft) -> Unit,
    onCaptureEvidence: () -> Unit,
    onCameraPermissionNeeded: () -> Unit,
    onCameraPermissionDenied: () -> Unit,
) {
    val context = LocalContext.current
    val cameraPermission = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { granted ->
        if (granted) {
            onCameraPermissionNeeded()
        } else {
            onCameraPermissionDenied()
        }
    }
    var resultType by rememberSaveable { mutableStateOf(WorkResultType.COMPLETED) }
    var diagnosis by rememberSaveable { mutableStateOf("") }
    var actionTaken by rememberSaveable { mutableStateOf("") }
    var showRequired by rememberSaveable { mutableStateOf(false) }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        if (busy) {
            LinearProgressIndicator(modifier = Modifier.fillMaxWidth())
        }
        OutlinedButton(
            onClick = onBack,
            modifier = Modifier.heightIn(min = 48.dp),
        ) {
            Text(stringResource(R.string.back))
        }
        LocationConsentControls(
            status = locationConsent,
            busy = busy,
            onGrant = onLocationGrant,
            onSuspend = onLocationSuspend,
            onResume = onLocationResume,
            onWithdraw = onLocationWithdraw,
        )
        Text(
            text = order.requestNo,
            style = MaterialTheme.typography.headlineSmall,
        )
        Text(
            text = stringResource(R.string.equipment_format, order.managementNo, order.modelName),
            style = MaterialTheme.typography.bodyLarge,
        )
        Text(
            text = stringResource(R.string.site_format, order.customerName, order.siteName),
            style = MaterialTheme.typography.bodyLarge,
        )
        order.symptom?.takeIf { it.isNotBlank() }?.let {
            Text(
                text = stringResource(R.string.symptom_format, it),
                style = MaterialTheme.typography.bodyMedium,
            )
        }
        order.targetDueAt?.let {
            Text(
                text = stringResource(R.string.due_format, it.format(DateTimeFormatter.ISO_LOCAL_DATE_TIME)),
                style = MaterialTheme.typography.bodyMedium,
            )
        }
        FlowRow(
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            AssistChip(
                onClick = {},
                label = { Text(stringResource(order.priority.labelRes())) },
            )
            AssistChip(
                onClick = {},
                label = { Text(stringResource(order.status.labelRes())) },
            )
            AssistChip(
                onClick = {},
                label = { Text(stringResource(order.syncState.labelRes())) },
            )
        }
        Button(
            onClick = onStart,
            enabled = !busy,
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = 48.dp),
        ) {
            Text(stringResource(R.string.detail_start_work))
        }
        Text(
            text = stringResource(R.string.detail_submit_report),
            style = MaterialTheme.typography.titleMedium,
        )
        Text(
            text = stringResource(R.string.report_result_type),
            style = MaterialTheme.typography.bodyMedium,
        )
        FlowRow(
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            listOf(
                WorkResultType.COMPLETED,
                WorkResultType.TEMPORARY_ACTION,
                WorkResultType.INCOMPLETE,
                WorkResultType.REVISIT_REQUIRED,
            ).forEach { option ->
                FilterChip(
                    selected = resultType == option,
                    onClick = { resultType = option },
                    label = { Text(stringResource(option.labelRes())) },
                )
            }
        }
        OutlinedTextField(
            value = diagnosis,
            onValueChange = {
                diagnosis = it
                showRequired = false
            },
            label = { Text(stringResource(R.string.report_diagnosis)) },
            isError = showRequired && diagnosis.isBlank(),
            minLines = 3,
            modifier = Modifier.fillMaxWidth(),
        )
        OutlinedTextField(
            value = actionTaken,
            onValueChange = {
                actionTaken = it
                showRequired = false
            },
            label = { Text(stringResource(R.string.report_action)) },
            isError = showRequired && actionTaken.isBlank(),
            supportingText = {
                if (showRequired) {
                    Text(stringResource(R.string.error_required))
                }
            },
            minLines = 3,
            modifier = Modifier.fillMaxWidth(),
        )
        Button(
            onClick = {
                if (diagnosis.isBlank() || actionTaken.isBlank()) {
                    showRequired = true
                } else {
                    onReport(
                        ReportDraft(
                            resultType = resultType,
                            diagnosis = diagnosis.trim(),
                            actionTaken = actionTaken.trim(),
                        ),
                    )
                }
            },
            enabled = !busy,
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = 48.dp),
        ) {
            Text(stringResource(R.string.report_submit))
        }
        OutlinedButton(
            onClick = {
                if (ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) ==
                    PackageManager.PERMISSION_GRANTED
                ) {
                    onCaptureEvidence()
                } else {
                    cameraPermission.launch(Manifest.permission.CAMERA)
                }
            },
            enabled = !busy,
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = 48.dp),
        ) {
            Text(stringResource(R.string.detail_capture_evidence))
        }
    }
}

@Composable
internal fun LocationConsentControls(
    status: LocationConsentStatus?,
    busy: Boolean,
    onGrant: () -> Unit,
    onSuspend: () -> Unit,
    onResume: () -> Unit,
    onWithdraw: () -> Unit,
) {
    val state = status?.state ?: LocationConsentState.NO_RECORD
    Card(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 8.dp),
        shape = MaterialTheme.shapes.small,
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
    ) {
        Column(
            modifier = Modifier.padding(14.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    text = stringResource(R.string.location_consent_title),
                    style = MaterialTheme.typography.titleMedium,
                    modifier = Modifier.weight(1f),
                )
                AssistChip(
                    onClick = {},
                    label = { Text(stringResource(state.labelRes())) },
                )
            }
            Text(
                text = stringResource(
                    R.string.location_consent_collection_format,
                    stringResource(if (status?.mayCollect == true) R.string.yes else R.string.no),
                ),
                style = MaterialTheme.typography.bodyMedium,
            )
            FlowRow(
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Button(
                    onClick = onGrant,
                    enabled = !busy && state != LocationConsentState.GRANTED,
                    modifier = Modifier.heightIn(min = 48.dp),
                ) {
                    Text(
                        stringResource(
                            if (state == LocationConsentState.WITHDRAWN) {
                                R.string.location_consent_regain
                            } else {
                                R.string.location_consent_grant
                            },
                        ),
                    )
                }
                OutlinedButton(
                    onClick = onSuspend,
                    enabled = !busy && state == LocationConsentState.GRANTED,
                    modifier = Modifier.heightIn(min = 48.dp),
                ) {
                    Text(stringResource(R.string.location_consent_suspend))
                }
                OutlinedButton(
                    onClick = onResume,
                    enabled = !busy && state == LocationConsentState.SUSPENDED,
                    modifier = Modifier.heightIn(min = 48.dp),
                ) {
                    Text(stringResource(R.string.location_consent_resume))
                }
                OutlinedButton(
                    onClick = onWithdraw,
                    enabled = !busy && (
                        state == LocationConsentState.GRANTED ||
                            state == LocationConsentState.SUSPENDED
                        ),
                    modifier = Modifier.heightIn(min = 48.dp),
                ) {
                    Text(stringResource(R.string.location_consent_withdraw))
                }
            }
        }
    }
}
