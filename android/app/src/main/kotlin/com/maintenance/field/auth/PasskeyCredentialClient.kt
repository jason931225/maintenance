package com.maintenance.field.auth

import android.content.Context
import androidx.credentials.CredentialManager
import androidx.credentials.GetCredentialRequest
import androidx.credentials.GetPublicKeyCredentialOption
import androidx.credentials.PublicKeyCredential
import androidx.credentials.exceptions.NoCredentialException
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.jsonObject

interface PasskeyCredentialClient {
    suspend fun getLoginCredential(context: Context, challengeJson: String): Map<String, JsonElement>

    suspend fun getStepUpCredential(context: Context, challengeJson: String): Map<String, JsonElement> =
        getLoginCredential(context, challengeJson)
}

class CredentialManagerPasskeyClient : PasskeyCredentialClient {
    override suspend fun getLoginCredential(
        context: Context,
        challengeJson: String,
    ): Map<String, JsonElement> {
        val request = GetCredentialRequest(
            listOf(GetPublicKeyCredentialOption(requestJson = challengeJson)),
        )
        val credential = try {
            CredentialManager.create(context)
                .getCredential(context, request)
                .credential as? PublicKeyCredential
                ?: error("unsupported credential response")
        } catch (error: NoCredentialException) {
            throw IllegalStateException("passkey credential unavailable", error)
        }

        return Json.parseToJsonElement(credential.authenticationResponseJson)
            .jsonObject
            .toMap()
    }
}
