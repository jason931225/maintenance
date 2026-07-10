plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
    id("com.google.devtools.ksp")
    id("io.github.takahirom.roborazzi")
}

val androidKeystorePath = providers.environmentVariable("ANDROID_KEYSTORE_PATH")
val androidKeystorePassword = providers.environmentVariable("ANDROID_KEYSTORE_PASSWORD")
val androidKeyAlias = providers.environmentVariable("ANDROID_KEY_ALIAS")
val androidKeyPassword = providers.environmentVariable("ANDROID_KEY_PASSWORD")
val fieldE2eSessionAssetsDir = providers.environmentVariable("FIELD_E2E_SESSION_ASSETS_DIR")
val androidReleaseSigningReady = listOf(
    androidKeystorePath,
    androidKeystorePassword,
    androidKeyAlias,
    androidKeyPassword,
).all { it.isPresent }

android {
    namespace = "com.maintenance.field"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.maintenance.field"
        minSdk = 26
        targetSdk = 36
        versionCode = 1
        versionName = "0.1.0"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        // Default/debug target: the host loopback as seen from the Android emulator.
        // Overridden per build type below (release points at production).
        buildConfigField("String", "API_BASE_URL", "\"http://10.0.2.2:8080\"")
    }

    sourceSets {
        getByName("androidTest") {
            fieldE2eSessionAssetsDir.orNull
                ?.takeIf { it.isNotBlank() }
                ?.let { assets.srcDir(it) }
        }
    }

    buildFeatures {
        buildConfig = true
        compose = true
    }

    testOptions {
        unitTests {
            // Robolectric needs the merged Android resources (strings.xml, theme) on the
            // JVM classpath so the real composables resolve stringResource(...) and render
            // the Korean labels exactly as on-device.
            isIncludeAndroidResources = true
            isReturnDefaultValues = true
        }

        managedDevices {
            allDevices {
                // CI-only Gradle Managed Device for the instrumented post-login E2E.
                // Run with: ./gradlew fieldApi34DebugAndroidTest (needs KVM).
                create<com.android.build.api.dsl.ManagedVirtualDevice>("fieldApi34") {
                    device = "Pixel 6"
                    apiLevel = 34
                    systemImageSource = "google_apis_playstore"
                }
            }
        }
    }

    signingConfigs {
        create("release") {
            androidKeystorePath.orNull?.let { storeFile = file(it) }
            storePassword = androidKeystorePassword.orNull
            keyAlias = androidKeyAlias.orNull
            keyPassword = androidKeyPassword.orNull
        }
    }

    buildTypes {
        release {
            // Release builds ship to real devices and must reach production over TLS,
            // not the emulator loopback. The generated client appends /api/v1/... itself,
            // and the prod ingress routes /api on this host to the API server.
            buildConfigField("String", "API_BASE_URL", "\"https://fsm.knllogistic.com\"")
            if (androidReleaseSigningReady) {
                signingConfig = signingConfigs.getByName("release")
            }
        }
    }

    lint {
        abortOnError = true
        warningsAsErrors = true
        checkReleaseBuilds = true
        disable += setOf(
            "AndroidGradlePluginVersion",
            "GradleDependency",
            "NewerVersionAvailable",
            "OldTargetApi",
        )
    }
}

kotlin {
    jvmToolchain(21)
}

ksp {
    arg("room.schemaLocation", "$projectDir/schemas")
}

dependencies {
    implementation("com.maintenance:maintenance-api-client:0.1.0")

    implementation(platform("androidx.compose:compose-bom:2026.05.01"))
    implementation("androidx.activity:activity-compose:1.12.4")
    implementation("androidx.compose.foundation:foundation")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.runtime:runtime")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-text")
    implementation("androidx.compose.ui:ui-tooling-preview")
    // core-ktx 1.19 + lifecycle 2.10 require compileSdk 37 / AGP 9.1 — held until
    // the Android toolchain (Gradle 9 / AGP 9 / Kotlin) migration. okhttp (below)
    // is a JAR with no AAR-metadata floor, so its security bump stays.
    implementation("androidx.core:core-ktx:1.18.0")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.9.4")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.9.4")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.9.4")

    implementation("androidx.camera:camera-camera2:1.6.1")
    implementation("androidx.camera:camera-lifecycle:1.6.1")
    implementation("androidx.camera:camera-view:1.6.1")
    implementation("androidx.credentials:credentials:1.6.0")
    implementation("androidx.credentials:credentials-play-services-auth:1.6.0")
    implementation("androidx.room:room-ktx:2.8.4")
    implementation("androidx.room:room-runtime:2.8.4")
    implementation("com.squareup.okhttp3:okhttp:5.4.0")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.9.0")
    ksp("androidx.room:room-compiler:2.8.4")

    debugImplementation("androidx.compose.ui:ui-tooling")

    testImplementation(kotlin("test"))
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.10.2")

    // Robolectric-backed Compose UI tests (src/test, JVM, no emulator). The compose-bom
    // pins ui-test-junit4 / ui-test-junit4-accessibility (1.11.2) so no explicit versions.
    testImplementation("org.robolectric:robolectric:4.15.1")
    testImplementation("androidx.test.ext:junit:1.3.0")
    testImplementation("androidx.test:core-ktx:1.7.0")
    testImplementation("androidx.compose.ui:ui-test-junit4")
    // ATF-backed accessibility checks: ui-test-junit4-accessibility carries the
    // Accessibility Test Framework transitively, so enableAccessibilityChecks() works
    // without pinning ATF directly.
    testImplementation("androidx.compose.ui:ui-test-junit4-accessibility")
    // Roborazzi screenshot testing (record goldens / verify as the gate).
    testImplementation("io.github.takahirom.roborazzi:roborazzi:1.64.0")
    testImplementation("io.github.takahirom.roborazzi:roborazzi-compose:1.64.0")
    testImplementation("io.github.takahirom.roborazzi:roborazzi-junit-rule:1.64.0")

    // ui-test-manifest provides the empty Activity that createComposeRule() launches.
    // debugImplementation is the canonical scope: AGP merges the manifest into the debug
    // unit-test binary (packageDebugUnitTestForUnitTest) so Robolectric resolves
    // ComponentActivity. CI runs only testDebugUnitTest (not testReleaseUnitTest), so this
    // covers the full test scope. See the `build -x test` note in ci.yml.
    debugImplementation("androidx.compose.ui:ui-test-manifest")

    // Instrumented post-login E2E (src/androidTest) — CI-only (needs an emulator).
    // The compose-bom must be on the androidTest classpath too so ui-test-junit4 resolves.
    androidTestImplementation(platform("androidx.compose:compose-bom:2026.05.01"))
    androidTestImplementation("androidx.test.ext:junit:1.3.0")
    androidTestImplementation("androidx.test:core-ktx:1.7.0")
    androidTestImplementation("androidx.test:runner:1.7.0")
    androidTestImplementation("androidx.test:rules:1.7.0")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.7.0")
    androidTestImplementation("androidx.compose.ui:ui-test-junit4")
}
