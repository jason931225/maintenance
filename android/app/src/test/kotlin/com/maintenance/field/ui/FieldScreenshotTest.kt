package com.maintenance.field.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.DeviceConfigurationOverride
import androidx.compose.ui.test.DarkMode
import androidx.compose.ui.test.FontScale
import androidx.compose.ui.test.ForcedSize
import androidx.compose.ui.test.then
import androidx.compose.ui.unit.DpSize
import androidx.compose.ui.unit.dp
import com.github.takahirom.roborazzi.RoborazziOptions
import com.github.takahirom.roborazzi.captureRoboImage
import com.maintenance.field.ui.theme.FieldTheme
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * Roborazzi screenshot tests: each field screen × light/dark × font-scale 2× ×
 * COMPACT/MEDIUM window. Goldens live under src/test/snapshots (recordRoborazziDebug)
 * and verifyRoborazziDebug is the regression gate.
 *
 * The screens are the REAL composables rendered with REAL domain fixtures — the same
 * no-fakes path as [FieldScreensTest]. captureRoboImage renders the composable lambda
 * directly under a [DeviceConfigurationOverride], so no emulator and no compose rule are
 * needed.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "ko")
class FieldScreenshotTest {
    private enum class Window(val size: DpSize) {
        COMPACT(DpSize(360.dp, 720.dp)),
        MEDIUM(DpSize(700.dp, 1000.dp)),
    }

    // A small change-threshold absorbs sub-pixel anti-aliasing noise (notably between the
    // recording host and the Linux CI host) while still failing on real layout/text changes.
    private val roborazziOptions = RoborazziOptions(
        compareOptions = RoborazziOptions.CompareOptions(changeThreshold = 0.01f),
    )

    private fun capture(
        name: String,
        dark: Boolean,
        window: Window,
        content: @Composable () -> Unit,
    ) {
        val mode = if (dark) "dark" else "light"
        captureRoboImage(
            filePath = "src/test/snapshots/field_${name}_${mode}_${window.name.lowercase()}.png",
            roborazziOptions = roborazziOptions,
        ) {
            DeviceConfigurationOverride(
                DeviceConfigurationOverride.ForcedSize(window.size)
                    .then(DeviceConfigurationOverride.FontScale(2.0f))
                    .then(DeviceConfigurationOverride.DarkMode(dark)),
            ) {
                FieldTheme {
                    Surface(
                        modifier = Modifier.fillMaxSize(),
                        color = MaterialTheme.colorScheme.background,
                    ) {
                        Box(modifier = Modifier.fillMaxSize()) { content() }
                    }
                }
            }
        }
    }

    private fun captureMatrix(name: String, content: @Composable () -> Unit) {
        for (dark in listOf(false, true)) {
            for (window in Window.entries) {
                capture(name, dark, window, content)
            }
        }
    }

    @Test
    fun today_screen_matrix() = captureMatrix("today") {
        TodayScreen(
            orders = FieldFixtures.todayOrders,
            busy = false,
            locationConsent = FieldFixtures.grantedConsent,
            onRefresh = {},
            onLogout = {},
            onLocationGrant = {},
            onLocationSuspend = {},
            onLocationResume = {},
            onLocationWithdraw = {},
            onSelect = {},
        )
    }

    @Test
    fun login_screen_matrix() = captureMatrix("login") {
        LoginScreen(busy = false, onLogin = {})
    }

    @Test
    fun detail_screen_matrix() = captureMatrix("detail") {
        WorkOrderDetailScreen(
            order = FieldFixtures.urgentWorkOrder,
            busy = false,
            locationConsent = FieldFixtures.grantedConsent,
            onBack = {},
            onLocationGrant = {},
            onLocationSuspend = {},
            onLocationResume = {},
            onLocationWithdraw = {},
            onStart = {},
            onReport = {},
            onCaptureEvidence = {},
            onCameraPermissionNeeded = {},
            onCameraPermissionDenied = {},
        )
    }

    @Test
    fun messenger_screen_matrix() = captureMatrix("messenger") {
        MessengerScreen(
            state = FieldFixtures.populatedMessengerState(),
            busy = false,
            searchQuery = "",
            draft = "",
            onSearchQueryChange = {},
            onDraftChange = {},
            onRefresh = {},
            onSelectThread = {},
            onLoadOlder = {},
            onSearch = {},
            onSend = {},
        )
    }
}
