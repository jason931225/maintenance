package com.maintenance.field.data.location

import com.maintenance.api.client.model.LocationConsentState
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class LocationConsentStateMachineTest {
    @Test
    fun gpsOffSwitchSuspendsCollectionImmediately() {
        val machine = LocationConsentStateMachine()
        val active = GpsCollectionState(
            consentState = LocationConsentState.GRANTED,
            onDuty = true,
        )

        val suspended = machine.reduce(active, LocationConsentEvent.Suspended)

        assertEquals(LocationConsentState.SUSPENDED, suspended.consentState)
        assertFalse(suspended.mayCollect)
    }

    @Test
    fun collectionRequiresGrantedConsentAndOnDuty() {
        val offDuty = GpsCollectionState(
            consentState = LocationConsentState.GRANTED,
            onDuty = false,
        )
        val onDuty = LocationConsentStateMachine()
            .reduce(offDuty, LocationConsentEvent.OnDutyChanged(true))

        assertFalse(offDuty.mayCollect)
        assertTrue(onDuty.mayCollect)
        assertFalse(
            onDuty.copy(consentState = LocationConsentState.WITHDRAWN).mayCollect,
        )
    }

    @Test
    fun withdrawalDestroysLocalEligibilityFromGrantedOrSuspendedStates() {
        val machine = LocationConsentStateMachine()

        assertEquals(
            LocationConsentState.WITHDRAWN,
            machine.reduce(
                GpsCollectionState(LocationConsentState.GRANTED, onDuty = true),
                LocationConsentEvent.Withdrawn,
            ).consentState,
        )
        assertEquals(
            LocationConsentState.WITHDRAWN,
            machine.reduce(
                GpsCollectionState(LocationConsentState.SUSPENDED, onDuty = true),
                LocationConsentEvent.Withdrawn,
            ).consentState,
        )
    }
}
