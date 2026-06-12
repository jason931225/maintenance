package com.maintenance.field.data.api

import com.maintenance.api.client.model.SubmitReportRequest
import com.maintenance.api.client.model.WorkResultType

data class ReportDraft(
    val resultType: WorkResultType,
    val diagnosis: String,
    val actionTaken: String,
) {
    fun toSubmitReportRequest(): SubmitReportRequest = SubmitReportRequest(
        resultType = resultType,
        diagnosis = diagnosis.trim(),
        actionTaken = actionTaken.trim(),
    )
}
