package com.maintenance.field.data.location

import com.maintenance.api.client.model.LocationConsentStatus
import com.maintenance.api.client.model.LocationPingRequest
import com.maintenance.field.data.api.MaintenanceApiGateway
import java.time.OffsetDateTime

class LocationConsentRepository(
    private val api: MaintenanceApiGateway,
) {
    suspend fun status(): LocationConsentStatus =
        api.getLocationConsentStatus()

    suspend fun grant(): LocationConsentStatus =
        api.grantLocationConsent()

    suspend fun suspend(): LocationConsentStatus =
        api.suspendLocationConsent()

    suspend fun resume(): LocationConsentStatus =
        api.resumeLocationConsent()

    suspend fun withdraw(): LocationConsentStatus =
        api.withdrawLocationConsent()

    suspend fun recordPingIfAllowed(
        state: GpsCollectionState,
        latitude: Double,
        longitude: Double,
        accuracyM: Double?,
        recordedAt: OffsetDateTime,
    ): Boolean {
        if (!state.mayCollect) {
            return false
        }

        api.recordLocationPing(
            LocationPingRequest(
                latitude = latitude,
                longitude = longitude,
                recordedAt = recordedAt,
                onDuty = state.onDuty,
                branchId = null,
                accuracyM = accuracyM,
            ),
        )
        return true
    }
}
