package com.maintenance.field

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.maintenance.field.data.session.SessionTokenStore
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.RuleChain
import org.junit.rules.TestRule
import org.junit.runner.Description
import org.junit.runner.RunWith
import org.junit.runners.model.Statement
import java.io.IOException
import java.util.Properties
import java.util.UUID

/**
 * Instrumented post-login E2E against the checked-out backend — CI-only (needs an emulator).
 *
 * No-fakes session design:
 *  - CI creates a fresh PostgreSQL database, boots the backend built from GITHUB_SHA,
 *    redeems a random short-lived mechanic OTP, and writes the resulting access+refresh
 *    pair to a permission-restricted temporary androidTest asset fixture (see
 *    .github/workflows/ci.yml android-instrumented). Tokens never travel through GitHub
 *    outputs or raw Gradle CLI arguments.
 *  - The test seeds those real tokens into the app's REAL [SessionTokenStore]
 *    BEFORE launching [MainActivity]. The store persists them through the same encrypted
 *    Android session path used after passkey login. The app's normal boot path then calls
 *    auth.hasSession() and restores the session — exactly as it does after an on-device
 *    passkey login. There is NO test-only code path in the app and NO fake auth repository /
 *    fake gateway.
 *
 * This is a required CI test: a missing or malformed session fixture is a test failure,
 * never a skip. The hermetic CI job creates the fixture from its isolated backend.
 */
@RunWith(AndroidJUnit4::class)
class WorkOrderFlowTest {
    private val sessionTokens = loadE2eSessionTokens()

    private val sessionStore =
        SessionTokenStore(ApplicationProvider.getApplicationContext())

    private val composeRule = createAndroidComposeRule<MainActivity>()

    /**
     * Session persistence must happen before [MainActivity] is created: FieldApp captures
     * auth.hasSession() during composition. RuleChain makes that ordering explicit instead
     * of relying on a @Before hook that can run after an activity rule launches the app.
     */
    @get:Rule
    val e2eRule: TestRule = RuleChain
        .outerRule(SessionSeedRule(sessionStore, sessionTokens))
        .around(composeRule)

    @Test
    fun seededSession_bootsAuthenticated_andDrivesFieldFlow() {
        val container = (composeRule.activity.application as MaintenanceFieldApplication).container
        // The restored real session means the app boots past the login screen.
        assertTrue(
            "App should restore the seeded real session and skip login",
            container.auth.hasSession(),
        )

        val seededWorkOrder = runBlocking {
            withContext(Dispatchers.IO) {
                container.apiGateway.listTodayWorkOrders()
                    .firstOrNull { it.id == ASSIGNED_MECHANIC_WORK_ORDER_ID }
            }
        }
        checkNotNull(seededWorkOrder) {
            "Authenticated mechanic should receive the deterministic seeded work order."
        }

        // This is the actual Compose tree, not a gateway-only assertion: it proves the app
        // left the login screen and rendered the precise f00003 work-order row from the API.
        composeRule.onNodeWithText("오늘 작업").assertIsDisplayed()
        composeRule.onAllNodesWithText("패스키 로그인").assertCountEquals(0)
        composeRule.waitUntil(timeoutMillis = UI_RENDER_TIMEOUT_MILLIS) {
            runCatching {
                composeRule.onNodeWithText(seededWorkOrder.requestNo).assertIsDisplayed()
            }.isSuccess
        }
        composeRule.onNodeWithText(seededWorkOrder.requestNo).assertIsDisplayed()
    }

    private data class E2eSessionTokens(
        val accessToken: String,
        val refreshToken: String,
    )

    private class SessionSeedRule(
        private val sessionStore: SessionTokenStore,
        private val tokens: E2eSessionTokens,
    ) : TestRule {
        override fun apply(base: Statement, description: Description): Statement =
            object : Statement() {
                override fun evaluate() {
                    // Write the SAME store the app writes after a real passkey login.
                    sessionStore.save(tokens.accessToken, tokens.refreshToken)
                    try {
                        base.evaluate()
                    } finally {
                        sessionStore.clear()
                    }
                }
            }
    }

    private fun loadE2eSessionTokens(): E2eSessionTokens {
        val properties = Properties()
        try {
            InstrumentationRegistry.getInstrumentation()
                .context
                .assets
                .open("field-e2e-session.properties")
                .use { properties.load(it) }
        } catch (error: IOException) {
            throw AssertionError(
                "Required field-e2e-session.properties fixture is missing or unreadable.",
                error,
            )
        }

        val access = properties.getProperty("FIELD_E2E_ACCESS_TOKEN")?.takeIf { it.isNotBlank() }
        val refresh = properties.getProperty("FIELD_E2E_REFRESH_TOKEN")?.takeIf { it.isNotBlank() }
        check(access != null && refresh != null) {
            "Required field-e2e-session.properties fixture has blank access or refresh token."
        }
        return E2eSessionTokens(access, refresh)
    }

    private companion object {
        const val UI_RENDER_TIMEOUT_MILLIS = 30_000L

        val ASSIGNED_MECHANIC_WORK_ORDER_ID: UUID =
            UUID.fromString("00000000-0000-0000-0000-000000f00003")
    }
}
