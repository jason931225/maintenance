package com.maintenance.field.ui

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.hasScrollAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.accessibility.enableAccessibilityChecks
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performScrollToNode
import androidx.compose.ui.test.performTextInput
import com.maintenance.field.data.api.TechnicianWorkOrder
import com.maintenance.field.ui.theme.FieldTheme
import java.util.UUID
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * Robolectric-backed Compose UI tests for the real field screens.
 *
 * Each test renders a REAL composable (from FieldApp.kt) with REAL domain models from
 * [FieldFixtures] — no fake gateway, no fake auth. The screens take plain data + callbacks,
 * so this exercises the exact rendering path used on-device, including the Korean string
 * resources resolved through the merged Android resources.
 *
 * Accessibility: every screen test calls enableAccessibilityChecks() (ATF), so the suite
 * fails on contentDescription gaps, touch-target, and contrast violations.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "ko")
class FieldScreensTest {
    @get:Rule
    val composeTestRule = createComposeRule()

    // --- TodayScreen ------------------------------------------------------------------

    @Test
    fun todayScreen_populated_rendersWorkOrdersWithKoreanLabels() {
        composeTestRule.enableAccessibilityChecks()
        composeTestRule.setContent {
            FieldTheme {
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
        }

        composeTestRule.onNodeWithText("오늘 작업").assertIsDisplayed()
        composeTestRule.onNodeWithText("WO-2026-0001").assertIsDisplayed()
        composeTestRule.onNodeWithText("긴급").assertIsDisplayed()
        composeTestRule.onNodeWithText("배정됨").assertIsDisplayed()
        composeTestRule.onNodeWithText("새로고침").assertIsEnabled()
        // The second card is below the fold in the list; scroll the lazy list to it,
        // then it is both present and displayed with its pending-sync chip.
        composeTestRule.onNode(hasScrollAction())
            .performScrollToNode(hasText("WO-2026-0002"))
        composeTestRule.onNodeWithText("WO-2026-0002").assertIsDisplayed()
        composeTestRule.onNodeWithText("동기화 대기").assertIsDisplayed()
    }

    @Test
    fun todayScreen_empty_rendersEmptyState() {
        composeTestRule.enableAccessibilityChecks()
        composeTestRule.setContent {
            FieldTheme {
                TodayScreen(
                    orders = emptyList(),
                    busy = false,
                    locationConsent = FieldFixtures.noRecordConsent,
                    onRefresh = {},
                    onLogout = {},
                    onLocationGrant = {},
                    onLocationSuspend = {},
                    onLocationResume = {},
                    onLocationWithdraw = {},
                    onSelect = {},
                )
            }
        }

        composeTestRule.onNodeWithText("오늘 배정된 작업이 없습니다.").assertIsDisplayed()
    }

    @Test
    fun todayScreen_busy_disablesRefreshAction() {
        composeTestRule.setContent {
            FieldTheme {
                TodayScreen(
                    orders = FieldFixtures.todayOrders,
                    busy = true,
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
        }

        composeTestRule.onNodeWithText("새로고침").assertIsNotEnabled()
    }

    @Test
    fun todayScreen_clickingOrder_invokesSelectWithThatOrder() {
        var selected: TechnicianWorkOrder? = null
        composeTestRule.setContent {
            FieldTheme {
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
                    onSelect = { selected = it },
                )
            }
        }

        composeTestRule.onNodeWithText("WO-2026-0001").performClick()
        assertEquals(FieldFixtures.urgentWorkOrder, selected)
    }


    // --- WorkHubScreen ---------------------------------------------------------------

    @Test
    fun workHubScreen_rendersPolicyAwareCollaborationSummary() {
        composeTestRule.enableAccessibilityChecks()
        composeTestRule.setContent {
            FieldTheme {
                WorkHubScreen(
                    summary = WorkHubSummary.build(
                        today = FieldFixtures.todayOrders,
                        messengerState = FieldFixtures.populatedMessengerState(),
                        gpsMayCollect = true,
                    ),
                    busy = false,
                    onRefresh = {},
                )
            }
        }

        composeTestRule.onNodeWithText("업무 허브").assertIsDisplayed()
        composeTestRule.onNodeWithText("오늘 작업 2건").assertIsDisplayed()
        composeTestRule.onNodeWithText("긴급 작업 1건").assertIsDisplayed()
        composeTestRule.onNodeWithText("목표일 있는 작업 1건").assertIsDisplayed()
        composeTestRule.onNodeWithText("민감한 승인·서명은 패스키 확인 후 처리").assertIsDisplayed()
        composeTestRule.onNode(hasScrollAction()).performScrollToNode(hasText("메신저 대화방 1개"))
        composeTestRule.onNodeWithText("메신저 대화방 1개").assertIsDisplayed()
        composeTestRule.onNode(hasScrollAction()).performScrollToNode(hasText("회사 메일은 MailUse 권한과 기기 보안 상태가 확인된 뒤 모바일 수신함으로 표시합니다."))
        composeTestRule.onNodeWithText("회사 메일은 MailUse 권한과 기기 보안 상태가 확인된 뒤 모바일 수신함으로 표시합니다.").assertIsDisplayed()
        composeTestRule.onNode(hasScrollAction()).performScrollToNode(hasText("폴·서베이는 대상 범위, 익명성, 마감, 감사 정책이 정해진 경우에만 발행합니다."))
        composeTestRule.onNodeWithText("폴·서베이는 대상 범위, 익명성, 마감, 감사 정책이 정해진 경우에만 발행합니다.").assertIsDisplayed()
    }

    @Test
    fun workHubSummary_capturesVisibleNativeWorkContextOnly() {
        val approvalOrder = FieldFixtures.urgentWorkOrder.copy(
            status = com.maintenance.api.client.model.WorkOrderStatus.ADMIN_REVIEW,
        )
        val summary = WorkHubSummary.build(
            today = listOf(approvalOrder, FieldFixtures.pendingWorkOrder),
            messengerState = FieldFixtures.populatedMessengerState(),
            gpsMayCollect = true,
        )

        assertEquals(2, summary.todayWorkCount)
        assertEquals(1, summary.urgentWorkCount)
        assertEquals(1, summary.approvalRelatedCount)
        assertEquals(1, summary.pendingSyncCount)
        assertEquals(1, summary.messengerThreadCount)
        assertEquals(1, summary.targetDueWorkCount)
    }

    // --- LoginScreen ------------------------------------------------------------------

    @Test
    fun loginScreen_rendersPasskeyPromptInKorean() {
        composeTestRule.enableAccessibilityChecks()
        composeTestRule.setContent {
            FieldTheme {
                LoginScreen(busy = false, onLogin = {})
            }
        }

        composeTestRule.onNodeWithText("패스키 로그인").assertIsDisplayed()
        composeTestRule.onNodeWithText("로그인").assertIsEnabled()
    }

    @Test
    fun loginScreen_invalidUserId_showsRequiredErrorAndDoesNotLogin() {
        var loggedInWith: UUID? = null
        composeTestRule.setContent {
            FieldTheme {
                LoginScreen(busy = false, onLogin = { loggedInWith = it })
            }
        }

        composeTestRule.onNodeWithText("로그인").performClick()
        composeTestRule.onNodeWithText("필수 입력값입니다.").assertIsDisplayed()
        assertNull(loggedInWith)
    }

    @Test
    fun loginScreen_validUserId_invokesLoginWithParsedUuid() {
        val userId = UUID.fromString("00000000-0000-0000-0000-000000000901")
        var loggedInWith: UUID? = null
        composeTestRule.setContent {
            FieldTheme {
                LoginScreen(busy = false, onLogin = { loggedInWith = it })
            }
        }

        composeTestRule.onNodeWithText("사용자 ID").performTextInput(userId.toString())
        composeTestRule.onNodeWithText("로그인").performClick()
        assertEquals(userId, loggedInWith)
    }

    @Test
    fun loginScreen_busy_showsLoadingLabelAndDisablesButton() {
        composeTestRule.setContent {
            FieldTheme {
                LoginScreen(busy = true, onLogin = {})
            }
        }

        composeTestRule.onNodeWithText("처리 중").assertIsNotEnabled()
    }

    // --- WorkOrderDetailScreen --------------------------------------------------------

    @Test
    fun detailScreen_populated_rendersReportFormInKorean() {
        composeTestRule.enableAccessibilityChecks()
        composeTestRule.setContent {
            FieldTheme {
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
        }

        // The symptom passed in the fixture renders via symptom_format near the top.
        composeTestRule.onNode(hasText("마스트 상승 불가", substring = true)).assertIsDisplayed()
        // The form controls live in a scrollable column; scroll each into view to assert it.
        composeTestRule.onNodeWithText("작업 시작").performScrollTo().assertIsDisplayed()
        composeTestRule.onNodeWithText("진단").performScrollTo().assertIsDisplayed()
        composeTestRule.onNodeWithText("조치 내용").performScrollTo().assertIsDisplayed()
        composeTestRule.onNodeWithText("증빙 촬영").performScrollTo().assertIsDisplayed()
    }

    @Test
    fun detailScreen_submitWithEmptyReport_showsRequiredErrorAndDoesNotSubmit() {
        var reported = false
        composeTestRule.setContent {
            FieldTheme {
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
                    onReport = { reported = true },
                    onCaptureEvidence = {},
                    onCameraPermissionNeeded = {},
                    onCameraPermissionDenied = {},
                )
            }
        }

        composeTestRule.onNodeWithText("제출").performScrollTo().performClick()
        composeTestRule.onNodeWithText("필수 입력값입니다.").performScrollTo().assertIsDisplayed()
        assertEquals(false, reported)
    }

    @Test
    fun detailScreen_startWork_invokesCallback() {
        var started = false
        composeTestRule.setContent {
            FieldTheme {
                WorkOrderDetailScreen(
                    order = FieldFixtures.urgentWorkOrder,
                    busy = false,
                    locationConsent = FieldFixtures.grantedConsent,
                    onBack = {},
                    onLocationGrant = {},
                    onLocationSuspend = {},
                    onLocationResume = {},
                    onLocationWithdraw = {},
                    onStart = { started = true },
                    onReport = {},
                    onCaptureEvidence = {},
                    onCameraPermissionNeeded = {},
                    onCameraPermissionDenied = {},
                )
            }
        }

        composeTestRule.onNodeWithText("작업 시작").performScrollTo().performClick()
        assertEquals(true, started)
    }

    // --- MessengerScreen --------------------------------------------------------------

    @Test
    fun messengerScreen_populated_rendersThreadAndMessage() {
        composeTestRule.enableAccessibilityChecks()
        composeTestRule.setContent {
            FieldTheme {
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

        composeTestRule.onNodeWithText("메신저").assertIsDisplayed()
        composeTestRule.onNodeWithText("WO-2026-0001 작업방").assertIsDisplayed()
        // The selected thread's message is further down the lazy list; scroll to it.
        composeTestRule.onNode(hasScrollAction())
            .performScrollToNode(hasText("부품 도착 예정 시간 공유 부탁드립니다."))
        composeTestRule.onNodeWithText("부품 도착 예정 시간 공유 부탁드립니다.").assertIsDisplayed()
    }

    @Test
    fun messengerScreen_empty_rendersEmptyThreadAndSelectPrompts() {
        composeTestRule.enableAccessibilityChecks()
        composeTestRule.setContent {
            FieldTheme {
                MessengerScreen(
                    state = FieldFixtures.emptyMessengerState(),
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

        composeTestRule.onNodeWithText("표시할 대화방이 없습니다.").assertIsDisplayed()
        composeTestRule.onNodeWithText("대화방을 선택하세요.").assertIsDisplayed()
    }

    @Test
    fun messengerScreen_noThreadSelected_sendButtonDisabled() {
        composeTestRule.setContent {
            FieldTheme {
                MessengerScreen(
                    state = FieldFixtures.emptyMessengerState(),
                    busy = false,
                    searchQuery = "",
                    draft = "본문",
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

        composeTestRule.onNodeWithText("전송").assertIsNotEnabled()
    }

    @Test
    fun messengerScreen_threadSelected_sendInvokesCallback() {
        var sent = false
        composeTestRule.setContent {
            FieldTheme {
                MessengerScreen(
                    state = FieldFixtures.populatedMessengerState(),
                    busy = false,
                    searchQuery = "",
                    draft = "부품 도착했습니다.",
                    onSearchQueryChange = {},
                    onDraftChange = {},
                    onRefresh = {},
                    onSelectThread = {},
                    onLoadOlder = {},
                    onSearch = {},
                    onSend = { sent = true },
                )
            }
        }

        composeTestRule.onNodeWithText("전송").performClick()
        assertEquals(true, sent)
    }

    // --- LocationConsentControls ------------------------------------------------------

    @Test
    fun locationConsent_granted_allowsSuspendAndWithdrawOnly() {
        composeTestRule.enableAccessibilityChecks()
        composeTestRule.setContent {
            FieldTheme {
                LocationConsentControls(
                    status = FieldFixtures.grantedConsent,
                    busy = false,
                    onGrant = {},
                    onSuspend = {},
                    onResume = {},
                    onWithdraw = {},
                )
            }
        }

        composeTestRule.onNodeWithText("GPS 위치 동의").assertIsDisplayed()
        composeTestRule.onNodeWithText("동의됨").assertIsDisplayed()
        // When granted: grant disabled, suspend/withdraw enabled, resume disabled.
        composeTestRule.onNodeWithText("동의").assertIsNotEnabled()
        composeTestRule.onNodeWithText("GPS 끄기").assertIsEnabled()
        composeTestRule.onNodeWithText("동의 철회").assertIsEnabled()
        composeTestRule.onNodeWithText("GPS 켜기").assertIsNotEnabled()
    }

    @Test
    fun locationConsent_noRecord_allowsGrantOnly() {
        composeTestRule.enableAccessibilityChecks()
        composeTestRule.setContent {
            FieldTheme {
                LocationConsentControls(
                    status = FieldFixtures.noRecordConsent,
                    busy = false,
                    onGrant = {},
                    onSuspend = {},
                    onResume = {},
                    onWithdraw = {},
                )
            }
        }

        composeTestRule.onNodeWithText("미동의").assertIsDisplayed()
        composeTestRule.onNodeWithText("동의").assertIsEnabled()
        composeTestRule.onNodeWithText("GPS 끄기").assertIsNotEnabled()
        composeTestRule.onNodeWithText("동의 철회").assertIsNotEnabled()
    }

    @Test
    fun locationConsent_grant_invokesCallback() {
        var granted = false
        composeTestRule.setContent {
            FieldTheme {
                LocationConsentControls(
                    status = FieldFixtures.noRecordConsent,
                    busy = false,
                    onGrant = { granted = true },
                    onSuspend = {},
                    onResume = {},
                    onWithdraw = {},
                )
            }
        }

        composeTestRule.onAllNodesWithText("동의")[0].performClick()
        assertEquals(true, granted)
    }
}
