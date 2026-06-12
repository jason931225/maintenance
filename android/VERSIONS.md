# Android Version Evidence

Verified on 2026-06-12 from official Maven/SDK metadata:

- Android Gradle Plugin metadata: Google Maven latest/release is `9.3.0-alpha12`; this project pins stable `8.13.2` to avoid AGP 9 Kotlin plugin migration in this slice.
- Kotlin Android plugin metadata: Maven Central latest/release is `2.4.0`; this project pins `2.2.20` to match the generated Kotlin client in `../clients/kotlin`.
- Compose BOM metadata: Google Maven latest/release is `2026.05.01`.
- Android SDK: command-line tools `20.0`, Platform `android-36`, Build-Tools `36.1.0`; `android-37.0` and Build-Tools `37.0.0` were also installed during verification, but this project compiles against 36 because AGP 8.13.2 recommends 36.
- Room metadata: Google Maven latest/release is `2.8.4`.
- Credential Manager metadata: Google Maven latest/release is `1.7.0-alpha02`; this project pins stable `1.6.0`.
- CameraX metadata: Google Maven latest/release is `1.7.0-alpha01`; this project pins stable `1.6.1`.

Quality policy for T1.6:

- `./gradlew build` is the required Android verification gate.
- Android lint has `warningsAsErrors=true` and `abortOnError=true`.
- JVM unit tests cover offline queue replay, generated client mappers, and login state transitions.
- Instrumented/E2E device tests are deferred to T1.8; this slice keeps the JVM layer real and does not use production mocks or demo modes.
