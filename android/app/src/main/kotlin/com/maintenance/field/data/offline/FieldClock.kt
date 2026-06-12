package com.maintenance.field.data.offline

import java.time.OffsetDateTime
import java.time.ZoneOffset

fun interface FieldClock {
    fun now(): OffsetDateTime
}

object SystemFieldClock : FieldClock {
    override fun now(): OffsetDateTime = OffsetDateTime.now(ZoneOffset.UTC)
}
