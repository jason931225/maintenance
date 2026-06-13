package com.maintenance.field.ui

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
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
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.maintenance.api.client.model.AttachmentStage
import com.maintenance.api.client.model.LocationConsentState
import com.maintenance.api.client.model.LocationConsentStatus
import com.maintenance.api.client.model.WorkResultType
import com.maintenance.field.AppContainer
import com.maintenance.field.R
import com.maintenance.field.auth.LoginState
import com.maintenance.field.data.api.ReportDraft
import com.maintenance.field.data.api.TechnicianWorkOrder
import com.maintenance.field.data.messenger.MessengerAction
import com.maintenance.field.data.messenger.MessengerMessage
import com.maintenance.field.data.messenger.MessengerReducer
import com.maintenance.field.data.messenger.MessengerSendState
import com.maintenance.field.data.messenger.MessengerState
import com.maintenance.field.data.messenger.MessengerThread
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import java.util.UUID
import kotlinx.coroutines.launch

private val messengerTimestampFormatter: DateTimeFormatter =
    DateTimeFormatter.ofLocalizedDateTime(FormatStyle.SHORT).withZone(ZoneId.systemDefault())

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
    var messengerState by remember { mutableStateOf(MessengerState()) }
    var messengerSearchQuery by rememberSaveable { mutableStateOf("") }
    var messengerDraft by rememberSaveable { mutableStateOf("") }
    var locationConsent by remember { mutableStateOf<LocationConsentStatus?>(null) }
    val selected = orders.firstOrNull { it.id.toString() == selectedId }
    val messengerReducer = remember { MessengerReducer() }
    val loginFailedMessage = stringResource(R.string.login_failed)
    val offlineQueuedMessage = stringResource(R.string.offline_queued)
    val reportSubmittedMessage = stringResource(R.string.report_submitted)
    val cameraPermissionDeniedMessage = stringResource(R.string.camera_permission_denied)
    val operationFailedMessage = stringResource(R.string.operation_failed)
    val messengerSendPendingMessage = stringResource(R.string.messenger_send_pending)
    val locationConsentFailedMessage = stringResource(R.string.location_consent_failed)

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

    LaunchedEffect(authenticated) {
        if (authenticated) {
            runCatching { container.workOrders.refreshToday() }
            runCatching { container.locationConsent.status() }
                .onSuccess { locationConsent = it }
                .onFailure { snackbarHostState.showSnackbar(locationConsentFailedMessage) }
        } else {
            locationConsent = null
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
                            authenticated = state is LoginState.Authenticated
                            busy = false
                            if (!authenticated) {
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
                                selectedId = null
                                messengerState = MessengerState()
                                locationConsent = null
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
                    } else {
                        MessengerScreen(
                            state = messengerState,
                            busy = busy,
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
            label = { Text(stringResource(R.string.messenger_title)) },
        )
    }
}

@Composable
private fun LoginScreen(
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
private fun TodayScreen(
    orders: List<TechnicianWorkOrder>,
    busy: Boolean,
    locationConsent: LocationConsentStatus?,
    modifier: Modifier = Modifier,
    onRefresh: () -> Unit,
    onLogout: () -> Unit,
    onLocationGrant: () -> Unit,
    onLocationSuspend: () -> Unit,
    onLocationResume: () -> Unit,
    onLocationWithdraw: () -> Unit,
    onSelect: (TechnicianWorkOrder) -> Unit,
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
private fun MessengerScreen(
    state: MessengerState,
    busy: Boolean,
    searchQuery: String,
    draft: String,
    modifier: Modifier = Modifier,
    onSearchQueryChange: (String) -> Unit,
    onDraftChange: (String) -> Unit,
    onRefresh: () -> Unit,
    onSelectThread: (MessengerThread) -> Unit,
    onLoadOlder: () -> Unit,
    onSearch: () -> Unit,
    onSend: () -> Unit,
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
                    MessengerMessageRow(message = message)
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
                    MessengerMessageRow(message = message)
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
                    text = thread.displayTitle,
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

@Composable
private fun MessengerMessageRow(message: MessengerMessage) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        shape = MaterialTheme.shapes.small,
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
    ) {
        Column(
            modifier = Modifier.padding(14.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
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
private fun WorkOrderDetailScreen(
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
private fun LocationConsentControls(
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
