package com.maintenance.api.client.api

import com.maintenance.api.client.model.FacilitiesAcceptanceRequest
import com.maintenance.api.client.model.FacilitiesAssignRequest
import com.maintenance.api.client.model.FacilitiesCase
import com.maintenance.api.client.model.FacilitiesObservationRequest
import com.maintenance.api.client.model.FacilitiesSubmitRequest
import com.maintenance.api.client.model.FacilitiesTriageRequest
import io.kotlintest.shouldBe
import io.kotlintest.specs.StringSpec
import java.time.OffsetDateTime
import java.util.UUID

private val triageReturn: suspend FacilitiesApi.(UUID, FacilitiesTriageRequest) -> FacilitiesCase =
    FacilitiesApi::triageFacilitiesCase
private val assignReturn: suspend FacilitiesApi.(UUID, FacilitiesAssignRequest) -> FacilitiesCase =
    FacilitiesApi::assignFacilitiesCase
private val startReturn: suspend FacilitiesApi.(UUID) -> FacilitiesCase =
    FacilitiesApi::startFacilitiesCase
private val submitReturn: suspend FacilitiesApi.(UUID, FacilitiesSubmitRequest) -> FacilitiesCase =
    FacilitiesApi::submitFacilitiesExecution
private val acceptanceReturn: suspend FacilitiesApi.(UUID, FacilitiesAcceptanceRequest) -> FacilitiesCase =
    FacilitiesApi::decideFacilitiesAcceptance
private val observationReturn: suspend FacilitiesApi.(UUID, FacilitiesObservationRequest) -> FacilitiesCase =
    FacilitiesApi::recordFacilitiesObservation

class FacilitiesApiContractTest : StringSpec({
    "generated facilities transitions return FacilitiesCase and retain typed required bodies" {
        listOf(
            triageReturn,
            assignReturn,
            startReturn,
            submitReturn,
            acceptanceReturn,
            observationReturn,
        ).size shouldBe 6
    }

    "generated FacilitiesCase retains its persisted branch scope" {
        val branchId = UUID.fromString("22222222-2222-4222-8222-222222222222")
        val dueAt = OffsetDateTime.parse("2026-07-23T00:00:00Z")
        val caseView = FacilitiesCase(
            id = UUID.fromString("11111111-1111-4111-8111-111111111111"),
            branchId = branchId,
            status = FacilitiesCase.Status.DUE,
            responseDueAt = dueAt,
            completionDueAt = dueAt,
            acceptanceDueAt = dueAt,
            totalCostKrw = 0,
        )

        caseView.branchId shouldBe branchId
    }
})
