# Kotlin generator templates

This directory contains narrow OpenAPI Generator template overrides for the
checked-in Kotlin client. `scripts/generate-kotlin-client.mjs` passes this
directory with `-t`, so changes here are the source of truth for generated
Kotlin client behavior that is not controlled by OpenAPI schema/config alone.

Current override:

- `jvm-common/infrastructure/Serializer.kt.mustache` is copied from
  OpenAPI Generator v7.23.0 and changes only the kotlinx-serialization shared
  `Json` defaults. Production/client-contract parsing is fail-closed by default
  (`ignoreUnknownKeys = false`, `isLenient = false`) and the shared generated
  client instance refuses broad compatibility relaxations. Route-specific
  compatibility exceptions must be implemented and documented separately with
  fixtures/tests.
