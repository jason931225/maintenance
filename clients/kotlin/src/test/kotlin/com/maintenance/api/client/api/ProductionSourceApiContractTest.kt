package com.maintenance.api.client.api

import com.maintenance.api.client.infrastructure.Serializer
import com.maintenance.api.client.model.ProductionCapacityIngress
import com.maintenance.api.client.model.ProductionDemandIngress
import com.maintenance.api.client.model.ProductionMaterialIngress
import com.maintenance.api.client.model.ProductionSourceIngress
import com.maintenance.api.client.model.ProductionSourceIngressReceipt
import com.maintenance.api.client.model.ProductionSourceIngressSerializer
import com.maintenance.api.client.model.ProductionSourceSystemCredential
import com.maintenance.api.client.model.ProductionSourceSystemGenerationRequest
import com.maintenance.api.client.model.ProductionSourceSystemReceipt
import com.maintenance.api.client.model.RegisterProductionSourceSystem
import io.kotlintest.shouldBe
import io.kotlintest.specs.StringSpec
import java.time.LocalDate
import java.time.OffsetDateTime
import java.util.UUID
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.encodeToJsonElement
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

private val sourceId = UUID.fromString("00000000-0000-0000-0000-000000000001")

private val registerReturn: suspend ProductionApi.(RegisterProductionSourceSystem) -> ProductionSourceSystemCredential =
    ProductionApi::registerProductionSourceSystem
private val rotateReturn: suspend ProductionApi.(UUID, ProductionSourceSystemGenerationRequest) -> ProductionSourceSystemCredential =
    ProductionApi::rotateProductionSourceSystem
private val disableReturn: suspend ProductionApi.(UUID, ProductionSourceSystemGenerationRequest) -> ProductionSourceSystemReceipt =
    ProductionApi::disableProductionSourceSystem
private val ingressReturn: suspend ProductionApi.(ProductionSourceIngress) -> ProductionSourceIngressReceipt =
    ProductionApi::ingestProductionSource

class ProductionSourceApiContractTest : StringSpec({
    "generated production source operations retain typed receipts and generation guards" {
        listOf(registerReturn, rotateReturn, disableReturn, ingressReturn).size shouldBe 4
        ProductionSourceSystemGenerationRequest(expectedGeneration = 1).expectedGeneration shouldBe 1
        Serializer.kotlinxSerializationJson.decodeFromString<ProductionSourceSystemCredential>(
            """{"id":"00000000-0000-0000-0000-000000000001","source_system":"erp","enabled":true,"credential_generation":1,"secret":"one-time-secret"}""",
        ).secret shouldBe "one-time-secret"
    }

    "generated production ingress serializes every source kind through the discriminator" {
        val ingress: List<Pair<String, ProductionSourceIngress>> = listOf(
            "demand" to ProductionDemandIngress(
                kind = ProductionDemandIngress.Kind.DEMAND,
                id = sourceId,
                inquiryId = sourceId,
                productCode = "WIDGET",
                quantity = 1,
                dueAt = OffsetDateTime.parse("2026-07-23T12:00:00Z"),
                sourceId = "erp",
                sourceVersion = "v1",
            ),
            "capacity" to ProductionCapacityIngress(
                kind = ProductionCapacityIngress.Kind.CAPACITY,
                id = sourceId,
                siteId = sourceId,
                capacityDate = LocalDate.parse("2026-07-23"),
                availableQuantity = 1,
                sourceId = "mes",
                sourceVersion = "v1",
            ),
            "material" to ProductionMaterialIngress(
                kind = ProductionMaterialIngress.Kind.MATERIAL,
                materialItemId = sourceId,
                quantityOnHandMilli = 1,
                safetyStockMilli = 0,
                sourceId = "wms",
                sourceVersion = "v1",
            ),
        )

        ingress.forEach { (expectedKind, value) ->
            val encoded = Serializer.kotlinxSerializationJson.encodeToJsonElement(ProductionSourceIngressSerializer, value)
            encoded.jsonObject["kind"]?.jsonPrimitive?.content shouldBe expectedKind
            val decoded = Serializer.kotlinxSerializationJson.decodeFromJsonElement(ProductionSourceIngressSerializer, encoded)
            decoded::class shouldBe value::class
        }
    }
})
