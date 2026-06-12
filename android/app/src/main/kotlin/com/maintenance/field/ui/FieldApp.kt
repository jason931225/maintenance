package com.maintenance.field.ui

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
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
import com.maintenance.api.client.model.WorkResultType
import com.maintenance.field.AppContainer
import com.maintenance.field.R
import com.maintenance.field.auth.LoginState
import com.maintenance.field.data.api.ReportDraft
import com.maintenance.field.data.api.TechnicianWorkOrder
import java.time.format.DateTimeFormatter
import java.util.UUID
import kotlinx.coroutines.launch

@Composable
fun FieldApp(container: AppContainer) {
    val context = LocalContext.current
    val orders by container.workOrders.observeToday().collectAsStateWithLifecycle(initialValue = emptyList())
    val snackbarHostState = remember { SnackbarHostState() }
    val scope = rememberCoroutineScope()
    var authenticated by rememberSaveable { mutableStateOf(container.auth.hasSession()) }
    var selectedId by rememberSaveable { mutableStateOf<String?>(null) }
    var showCamera by rememberSaveable { mutableStateOf(false) }
    var busy by rememberSaveable { mutableStateOf(false) }
    val selected = orders.firstOrNull { it.id.toString() == selectedId }
    val loginFailedMessage = stringResource(R.string.login_failed)
    val offlineQueuedMessage = stringResource(R.string.offline_queued)
    val reportSubmittedMessage = stringResource(R.string.report_submitted)
    val cameraPermissionDeniedMessage = stringResource(R.string.camera_permission_denied)
    val operationFailedMessage = stringResource(R.string.operation_failed)

    LaunchedEffect(authenticated) {
        if (authenticated) {
            runCatching { container.workOrders.refreshToday() }
        }
    }

    LaunchedEffect(selectedId) {
        selectedId?.let {
            runCatching { container.workOrders.refreshDetail(UUID.fromString(it)) }
        }
    }

    if (showCamera && selected != null) {
        val uploadFailed = stringResource(R.string.operation_failed)
        val uploadSaved = stringResource(R.string.capture_saved)
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
                    onBack = { selectedId = null },
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
                TodayScreen(
                    orders = orders,
                    busy = busy,
                    onRefresh = {
                        scope.launch {
                            busy = true
                            runCatching {
                                container.offlineQueue.replayPending()
                                container.evidence.uploadPending()
                                container.workOrders.refreshToday()
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
                    },
                    onSelect = { selectedId = it.id.toString() },
                )
            }
        }
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
    onRefresh: () -> Unit,
    onLogout: () -> Unit,
    onSelect: (TechnicianWorkOrder) -> Unit,
) {
    Column(
        modifier = Modifier.fillMaxSize(),
    ) {
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
    onBack: () -> Unit,
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
        OutlinedButton(
            onClick = onBack,
            modifier = Modifier.heightIn(min = 48.dp),
        ) {
            Text(stringResource(R.string.back))
        }
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
