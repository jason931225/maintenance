plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
    id("com.google.devtools.ksp")
}

val androidKeystorePath = providers.environmentVariable("ANDROID_KEYSTORE_PATH")
val androidKeystorePassword = providers.environmentVariable("ANDROID_KEYSTORE_PASSWORD")
val androidKeyAlias = providers.environmentVariable("ANDROID_KEY_ALIAS")
val androidKeyPassword = providers.environmentVariable("ANDROID_KEY_PASSWORD")
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

    buildFeatures {
        buildConfig = true
        compose = true
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
    implementation("com.squareup.okhttp3:okhttp:5.1.0")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.9.0")
    ksp("androidx.room:room-compiler:2.8.4")

    debugImplementation("androidx.compose.ui:ui-tooling")

    testImplementation(kotlin("test"))
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.10.2")
}
