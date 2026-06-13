package com.maintenance.field.data.location

import com.maintenance.api.client.model.LocationConsentState

data class GpsCollectionState(
    val consentState: LocationConsentState = LocationConsentState.NO_RECORD,
    val onDuty: Boolean = false,
) {
    val mayCollect: Boolean
        get() = consentState == LocationConsentState.GRANTED && onDuty
}

sealed interface LocationConsentEvent {
    data object Granted : LocationConsentEvent
    data object Suspended : LocationConsentEvent
    data object Resumed : LocationConsentEvent
    data object Withdrawn : LocationConsentEvent
    data class OnDutyChanged(val onDuty: Boolean) : LocationConsentEvent
}

class LocationConsentStateMachine {
    fun reduce(state: GpsCollectionState, event: LocationConsentEvent): GpsCollectionState =
        when (event) {
            LocationConsentEvent.Granted -> state.copy(
                consentState = when (state.consentState) {
                    LocationConsentState.NO_RECORD,
                    LocationConsentState.WITHDRAWN -> LocationConsentState.GRANTED
                    else -> state.consentState
                },
            )
            LocationConsentEvent.Suspended -> state.copy(
                consentState = if (state.consentState == LocationConsentState.GRANTED) {
                    LocationConsentState.SUSPENDED
                } else {
                    state.consentState
                },
            )
            LocationConsentEvent.Resumed -> state.copy(
                consentState = if (state.consentState == LocationConsentState.SUSPENDED) {
                    LocationConsentState.GRANTED
                } else {
                    state.consentState
                },
            )
            LocationConsentEvent.Withdrawn -> state.copy(
                consentState = when (state.consentState) {
                    LocationConsentState.GRANTED,
                    LocationConsentState.SUSPENDED -> LocationConsentState.WITHDRAWN
                    else -> state.consentState
                },
            )
            is LocationConsentEvent.OnDutyChanged -> state.copy(onDuty = event.onDuty)
        }
}
