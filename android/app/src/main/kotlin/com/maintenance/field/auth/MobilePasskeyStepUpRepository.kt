package com.maintenance.field.auth

import android.content.Context
import com.maintenance.api.client.model.MobilePasskeyStepUpBinding
import com.maintenance.api.client.model.MobilePasskeyStepUpEnvelope
import com.maintenance.api.client.model.PasskeyStepUpAssertion
import com.maintenance.field.data.api.MaintenanceApiGateway
import kotlinx.serialization.json.JsonObject

class MobilePasskeyStepUpRepository(
    private val api: MaintenanceApiGateway,
    private val credentialClient: PasskeyCredentialClient,
) {
    suspend fun requestStepUp(
        context: Context,
        binding: MobilePasskeyStepUpBinding,
    ): MobilePasskeyStepUpEnvelope {
        val start = api.startMobilePasskeyStepUp(binding)
        require(start.binding == binding) { "mobile passkey step-up binding mismatch" }

        val challengeJson = JsonObject(start.challenge).toString()
        val credential = credentialClient.getStepUpCredential(context, challengeJson)
        return MobilePasskeyStepUpEnvelope(
            binding = binding,
            assertion = PasskeyStepUpAssertion(
                ceremonyId = start.ceremonyId,
                credential = credential,
            ),
        )
    }
}