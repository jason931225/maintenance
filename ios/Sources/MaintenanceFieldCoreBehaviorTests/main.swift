import Foundation
import MaintenanceAPIClient
import MaintenanceFieldCore
import OpenAPIRuntime

@main
struct MaintenanceFieldCoreBehaviorTests {
    static func main() async throws {
        try loginStateMachineMirrorsAndroidRegistrationFlow()
        try passkeyChallengeParsingRejectsMalformedJSONWithoutLeakingInput()
        try passkeyChallengeParsingRejectsMissingChallengeWithoutLeakingInput()
        try passkeyChallengeParsingRejectsInvalidBase64URLWithoutLeakingChallengeMaterial()
        try passkeyChallengeParsingDecodesValidBase64URLChallenge()
        try passkeyChallengeParsingDecodesWrappedPublicKeyChallenge()
        try await passkeyStepUpRepositoryCreatesBoundGeneratedEnvelope()
        try await passkeyLoginRegistrationFailurePreservesSessionAndReturnsRetryPendingState()
        try await passkeyLoginAuthFailureClearsSessionAndReturnsLoginFailed()
        try await passkeyLoginMissingRefreshTokenClearsSessionAndReturnsLoginFailed()
        try locationConsentStateMachineMirrorsAndroidGpsGate()
        try workOrderMappersMirrorAndroidModels()
        try reportDraftTrimsGeneratedRequestFields()
        try workHubCollaborationActionsCaptureMobileOperationalState()
        try await mobileOperationsRepositoryCachesAndMutatesProductionSeams()
        try await mobileOperationsRepositoryRoutesNotificationsAndQueuesSensitiveActions()
        try await mobileOperationsRepositorySubmitsStepUpEnvelopesAndReplaysPerQueuedAttempt()
        try await mobileOperationsRepositoryRejectsNullStaleAndReplayedStepUpAssertions()
        try await mobileOperationsRepositoryDurableStoresSurviveReconstruction()
        try await evidenceUploadTransportFailuresStayPendingForRetry()
        try await evidenceUploadReplaysCustomPresignedHeaders()
        try await evidenceUploadReplaysPresignedContentTypeExactly()
        try await evidenceUploadDoesNotInventContentTypeWhenPresignOmitsIt()
        try await evidenceUploadRetryReplaySucceedsAndClearsPendingItem()
        try await evidenceUploadPermanentFileFailuresBecomeTerminal()
        try await fileBackedOfflineStoresRejectCorruptJSONWithoutDiscardingQueuedData()
        try await fileBackedOfflineStoresSurfaceWriteFailuresWithoutMutatingMemory()
        try await coreDataMutationQueueSurfacesFetchFailuresInsteadOfEmptyPending()
        try await coreDataMutationQueueSurfacesSaveFailuresInsteadOfReturningQueuedSuccess()
        try await offlineStartRetriesSameRequestIDAndAcceptsCachedSyncResult()
        try await failedOperationSurfacesQueueResultWithoutDroppingMutation()
        try await workOrderRepositoryQueuesOnlyTransportFailuresForStartAndReport()
        try await workOrderRepositoryDoesNotQueueWhenPostSuccessDetailRefreshFails()
        try messengerMappersAndReducerMirrorAndroidModels()
        try await offlineComposedMessagesQueueAndReplayDirectly()
        try messengerRealtimeRequestUsesBearerHeaderAndResumeCursor()
        try await keychainSessionStorePersistsTokensOutsideUserDefaults()
        try await keychainSessionStoreMigratesLegacyGroupSessionForward()
        print("MaintenanceFieldCoreBehaviorTests passed")
    }

    private static func loginStateMachineMirrorsAndroidRegistrationFlow() throws {
        let userID = "00000000-0000-0000-0000-000000000901"
        let ceremonyID = "00000000-0000-0000-0000-000000000902"
        let stateMachine = LoginStateMachine()

        let awaitingCredential = stateMachine.reduce(
            LoginState.signedOut(),
            LoginEvent.loginChallengeReceived(
                userID: userID,
                ceremonyID: ceremonyID,
                challengeJSON: #"{"challenge":"abc"}"#,
                expiresAt: isoDate("2026-06-12T09:05:00Z")
            )
        )

        try expectEqual(
            awaitingCredential,
            .awaitingPasskey(userID: userID, ceremonyID: ceremonyID, challengeJSON: #"{"challenge":"abc"}"#)
        )

        let registeringDevice = stateMachine.reduce(
            awaitingCredential,
            LoginEvent.passkeyVerified(
                accessToken: "access.jwt",
                refreshToken: "refresh-token",
                deviceID: "device-a",
                appVersion: "0.1.0"
            )
        )

        try expectEqual(
            registeringDevice,
            .registeringDevice(
                accessToken: "access.jwt",
                refreshToken: "refresh-token",
                deviceID: "device-a",
                platform: .ios,
                appVersion: "0.1.0"
            )
        )

        let authenticated = stateMachine.reduce(
            registeringDevice,
            LoginEvent.deviceRegistered(serverDeviceID: "00000000-0000-0000-0000-000000000903")
        )

        try expectEqual(authenticated, .authenticated(accessToken: "access.jwt", refreshToken: "refresh-token"))

        let failed = stateMachine.reduce(
            LoginState.awaitingPasskey(userID: userID, ceremonyID: ceremonyID, challengeJSON: "{}"),
            LoginEvent.failed(messageKey: "login_failed")
        )
        try expectEqual(failed, .signedOut(messageKey: "login_failed"))
    }

    private static func passkeyChallengeParsingRejectsMalformedJSONWithoutLeakingInput() throws {
        let rawChallengeBytes = "secret-challenge-bytes"
        let malformedJSON = "{\"challenge\":\"" + rawChallengeBytes + "\""
        try expectThrows(
            PasskeyChallengeParsingError.malformedJSON,
            redactedFragments: [malformedJSON, rawChallengeBytes]
        ) {
            try PasskeyChallengeParser.challengeData(from: malformedJSON)
        }
    }

    private static func passkeyChallengeParsingRejectsMissingChallengeWithoutLeakingInput() throws {
        let rawChallengeBytes = "secret-challenge-bytes"
        let missingChallenge = "{\"allowCredentials\":[],\"rawChallengeBytes\":\"" + rawChallengeBytes + "\"}"
        try expectThrows(
            PasskeyChallengeParsingError.missingChallenge,
            redactedFragments: [missingChallenge, rawChallengeBytes]
        ) {
            try PasskeyChallengeParser.challengeData(from: missingChallenge)
        }
    }

    private static func passkeyChallengeParsingRejectsInvalidBase64URLWithoutLeakingChallengeMaterial() throws {
        let rawChallengeBytes = "secret-challenge-bytes"
        let encodedChallenge = "c2VjcmV0LWNoYWxsZW5nZS1ieXRlcw!"
        let invalidChallenge = "{\"challenge\":\"" + encodedChallenge + "\",\"rawChallengeBytes\":\"" + rawChallengeBytes + "\"}"
        try expectThrows(
            PasskeyChallengeParsingError.invalidBase64URLChallenge,
            redactedFragments: [invalidChallenge, encodedChallenge, rawChallengeBytes]
        ) {
            try PasskeyChallengeParser.challengeData(from: invalidChallenge)
        }
    }

    private static func passkeyChallengeParsingDecodesValidBase64URLChallenge() throws {
        let validChallenge = #"{"challenge":"_-7dAH8"}"#
        try expectEqual(
            try PasskeyChallengeParser.challengeData(from: validChallenge),
            Data([0xff, 0xee, 0xdd, 0x00, 0x7f])
        )
    }

    private static func passkeyChallengeParsingDecodesWrappedPublicKeyChallenge() throws {
        let wrappedChallenge = #"{"publicKey":{"challenge":"_-7dAH8","allowCredentials":[]}}"#
        try expectEqual(
            try PasskeyChallengeParser.challengeData(from: wrappedChallenge),
            Data([0xff, 0xee, 0xdd, 0x00, 0x7f])
        )
    }

    private static func passkeyStepUpRepositoryCreatesBoundGeneratedEnvelope() async throws {
        let binding = mobileStepUpBinding(
            actionKind: .approvalDecision,
            objectID: workOrderID,
            reasonKey: .operationsPasskeyApprovalDecision,
            replayAttempt: nil
        )
        let gateway = RecordingPasskeyStepUpGateway(
            response: try generatedMobileStepUpStart(binding: binding)
        )
        let repository = PasskeyStepUpRepository(
            gateway: gateway,
            credentialProvider: StaticPasskeyCredentialProvider()
        )

        let envelope = try await repository.envelope(binding: binding)

        try expectEqual(gateway.startBindings, [binding])
        try expectEqual(envelope.binding, binding)
        try expectEqual(envelope.binding.replayAttempt, nil)
        try expectEqual(envelope.assertion.ceremonyId, stepUpCeremonyID)
    }

    private static func passkeyLoginRegistrationFailurePreservesSessionAndReturnsRetryPendingState() async throws {
        let userID = "00000000-0000-0000-0000-000000000901"
        let gateway = RecordingPasskeyAuthGateway(
            challenge: generatedPasskeyChallenge(),
            tokens: generatedTokenPair(refreshToken: "refresh-token"),
            registeredDevice: generatedDevice(pushToken: nil)
        )
        gateway.registrationError = URLError(.notConnectedToInternet)
        let sessionStore = InMemorySessionTokenStore()
        let repository = PasskeyAuthRepository(
            gateway: gateway,
            credentialProvider: StaticPasskeyCredentialProvider(),
            sessionStore: sessionStore,
            deviceIDStore: FixedDeviceIDStore(deviceID: "ios-device-a"),
            appVersion: "0.1.0"
        )

        let state = await repository.login(userID: userID)

        try expectEqual(
            state,
            .authenticated(
                accessToken: "access.jwt",
                refreshToken: "refresh-token",
                deviceRegistration: .retryPending(
                    DeviceRegistrationRetry(
                        deviceID: "ios-device-a",
                        platform: .ios,
                        appVersion: "0.1.0",
                        pushToken: nil,
                        status: .readyForReplay,
                        messageKey: "device_registration_retry_pending",
                        lastErrorClass: "URLError"
                    )
                )
            )
        )
        try expectEqual(await sessionStore.load(), AuthTokens(accessToken: "access.jwt", refreshToken: "refresh-token"))
        try expectEqual(await sessionStore.clearCalls(), 0)
        try expectEqual(gateway.registrationAttempts, ["ios-device-a@0.1.0"])
    }

    private static func passkeyLoginAuthFailureClearsSessionAndReturnsLoginFailed() async throws {
        let userID = "00000000-0000-0000-0000-000000000901"
        let gateway = RecordingPasskeyAuthGateway(
            challenge: generatedPasskeyChallenge(),
            tokens: generatedTokenPair(refreshToken: "refresh-token"),
            registeredDevice: generatedDevice(pushToken: nil)
        )
        gateway.finishError = URLError(.userAuthenticationRequired)
        let sessionStore = InMemorySessionTokenStore(tokens: AuthTokens(accessToken: "stale", refreshToken: "stale-refresh"))
        let repository = PasskeyAuthRepository(
            gateway: gateway,
            credentialProvider: StaticPasskeyCredentialProvider(),
            sessionStore: sessionStore,
            deviceIDStore: FixedDeviceIDStore(deviceID: "ios-device-a"),
            appVersion: "0.1.0"
        )

        let state = await repository.login(userID: userID)

        try expectEqual(state, .signedOut(messageKey: "login_failed"))
        try expectEqual(await sessionStore.load(), nil)
        try expectEqual(await sessionStore.clearCalls(), 1)
        try expectEqual(gateway.registrationAttempts, [])
    }

    private static func passkeyLoginMissingRefreshTokenClearsSessionAndReturnsLoginFailed() async throws {
        let userID = "00000000-0000-0000-0000-000000000901"
        let gateway = RecordingPasskeyAuthGateway(
            challenge: generatedPasskeyChallenge(),
            tokens: generatedTokenPair(refreshToken: nil),
            registeredDevice: generatedDevice(pushToken: nil)
        )
        let sessionStore = InMemorySessionTokenStore(tokens: AuthTokens(accessToken: "stale", refreshToken: "stale-refresh"))
        let repository = PasskeyAuthRepository(
            gateway: gateway,
            credentialProvider: StaticPasskeyCredentialProvider(),
            sessionStore: sessionStore,
            deviceIDStore: FixedDeviceIDStore(deviceID: "ios-device-a"),
            appVersion: "0.1.0"
        )

        let state = await repository.login(userID: userID)

        try expectEqual(state, .signedOut(messageKey: "login_failed"))
        try expectEqual(await sessionStore.load(), nil)
        try expectEqual(await sessionStore.clearCalls(), 1)
        try expectEqual(gateway.registrationAttempts, [])
    }

    private static func locationConsentStateMachineMirrorsAndroidGpsGate() throws {
        let machine = LocationConsentStateMachine()
        let active = GPSCollectionState(consentState: .granted, onDuty: true)

        let suspended = machine.reduce(active, event: .suspended)
        try expectEqual(suspended.consentState, .suspended)
        try expectEqual(suspended.mayCollect, false)

        let offDuty = GPSCollectionState(consentState: .granted, onDuty: false)
        try expectEqual(offDuty.mayCollect, false)
        try expectEqual(machine.reduce(offDuty, event: .onDutyChanged(true)).mayCollect, true)

        try expectEqual(machine.reduce(active, event: .withdrawn).consentState, .withdrawn)
        try expectEqual(machine.reduce(suspended, event: .withdrawn).consentState, .withdrawn)
    }

    private static func workOrderMappersMirrorAndroidModels() throws {
        let item = generatedWorkOrder(priority: .p1, status: .assigned)

        let mapped = item.toTechnicianWorkOrder(syncState: .pending)

        try expectEqual(item.id, mapped.id)
        try expectEqual(mapped.requestNo, "20260612-001")
        try expectEqual(mapped.managementNo, "290")
        try expectEqual(mapped.modelName, "GTS25DE")
        try expectEqual(mapped.customerName, "대성물류")
        try expectEqual(mapped.priority, .p1)
        try expectEqual(mapped.prioritySort, 0)
        try expectEqual(mapped.status, .assigned)
        try expectEqual(mapped.syncState, .pending)
        try expectEqual(mapped.assigneeNames, ["김정비"])
    }

    private static func reportDraftTrimsGeneratedRequestFields() throws {
        let request = ReportDraft(
            resultType: .completed,
            diagnosis: "  배터리 커넥터 접촉 불량  ",
            actionTaken: "  커넥터 교체 및 충전 확인  "
        ).toSubmitReportRequest()

        try expectEqual(request.resultType, .completed)
        try expectEqual(request.diagnosis, "배터리 커넥터 접촉 불량")
        try expectEqual(request.actionTaken, "커넥터 교체 및 충전 확인")
    }

    private static func workHubCollaborationActionsCaptureMobileOperationalState() throws {
        let actions = MobileCollaborationActionBuilder.build(
            counts: MobileCollaborationActionCounts(
                urgentWorkCount: 1,
                approvalRelatedCount: 2,
                pendingSyncCount: 1,
                messengerThreadCount: 3,
                targetDueWorkCount: 4
            )
        )

        try expectEqual(actions.map(\.kind), MobileCollaborationKind.allCases)
        try expectEqual(actions.first { $0.kind == .notification }?.count, 4)
        try expectEqual(actions.first { $0.kind == .approval }?.status, .actionRequired)
        try expectEqual(actions.first { $0.kind == .passkeySigning }?.requiresPasskey, true)
        try expectEqual(actions.first { $0.kind == .offlineSync }?.count, 1)
        try expectEqual(actions.first { $0.kind == .messenger }?.count, 3)
        try expectEqual(actions.first { $0.kind == .calendar }?.count, 4)
        try expectEqual(actions.first { $0.kind == .mail }?.status, .ready)
        try expectEqual(actions.first { $0.kind == .poll }?.valueKey, "work_hub_action_polls_value_ready")
    }



    private static func mobileOperationsRepositoryCachesAndMutatesProductionSeams() async throws {
        let gateway = RecordingMobileOperationsGateway()
        let cache = InMemoryMobileOperationsCacheStore()
        let repository = MobileOperationsRepository(
            gateway: gateway,
            cache: cache,
            notificationStore: InMemoryMobileNotificationStore(),
            sensitiveActionStore: InMemoryMobileSensitiveActionStore(),
            clock: FixedClock(date: isoDate("2026-06-12T12:00:00Z"))
        )

        let live = try await repository.refreshOverview()

        try expectEqual(live.origin, .live)
        try expectEqual(live.snapshot.approvals.total, 0)
        try expectEqual(live.snapshot.mailFolders.single()?.name, "받은메일함")
        try expectEqual(live.snapshot.mailThreads.single()?.unreadCount, 2)
        try expectEqual(live.snapshot.calendarEvents.single()?.title, "주간 정비 계획")
        try expectEqual(live.snapshot.polls.single()?.myVote.submitted, false)
        let dashboard = MobileOperationsDashboard(snapshot: live.snapshot)
        try expectEqual(dashboard.unreadMailCount, 2)
        try expectEqual(dashboard.mailThreads.single()?.subject, "승인 증빙 확인")
        try expectEqual(dashboard.calendarEvents.single()?.scopeType, .org)
        try expectEqual(dashboard.polls.single()?.canVote, true)
        try expectEqual(gateway.approvalQueries.count, 1)
        try expectEqual(gateway.approvalQueries.first?.limit, 50)
        try expectEqual(gateway.approvalQueries.first?.offset, 0)

        gateway.errorToThrow = URLError(.notConnectedToInternet)
        let cached = try await repository.refreshOverview()

        try expectEqual(cached.origin, .cachedAfterFailure)
        try expectEqual(cached.snapshot.mailThreads.single()?.id, mailThreadID)
        try expect(cached.failureDescription?.isEmpty == false, "offline fallback should retain failure detail")

        let readOverview = try await repository.markMailThreadSeen(threadID: mailThreadID, seen: true)

        try expectEqual(gateway.readStateRequests.count, 1)
        try expectEqual(gateway.readStateRequests.first?.threadID, mailThreadID)
        try expectEqual(gateway.readStateRequests.first?.seen, true)
        try expectEqual(readOverview?.snapshot.mailThreads.single()?.unreadCount, 0)

        let pollStepUp = generatedMobileStepUpEnvelope(
            actionKind: .pollVote,
            objectID: pollID,
            reasonKey: .operationsPasskeyPollVote,
            replayAttempt: nil,
            ceremonyID: "10000000-0000-4000-8000-000000000100"
        )
        let queuedPoll = try await repository.votePoll(pollID: pollID, selectedOptionIDs: [pollOptionID], stepUp: pollStepUp)

        try expectEqual(gateway.pollVoteRequests.count, 1)
        try expectEqual(gateway.pollVoteRequests.first?.pollID, pollID)
        try expectEqual(gateway.pollVoteRequests.first?.selectedOptionIDs, [pollOptionID])
        try expectEqual(gateway.pollVoteRequests.first?.stepUp.binding, pollStepUp.binding)
        try expectEqual(queuedPoll, nil)
        try expectEqual((await repository.cachedOverview())?.snapshot.polls.single()?.voteCount, 1)

        let device = try await repository.registerPushDevice(
            deviceID: "ios-device-a",
            appVersion: "0.1.0",
            pushToken: "apns-token"
        )

        try expectEqual(device.pushToken, "apns-token")
        try expectEqual(gateway.deviceRegistrations.count, 1)
        try expectEqual(gateway.deviceRegistrations.first?.deviceID, "ios-device-a")
        try expectEqual(gateway.deviceRegistrations.first?.appVersion, "0.1.0")
        try expectEqual(gateway.deviceRegistrations.first?.pushToken, "apns-token")

        try expectEqual(pollStepUp.binding.actionKind, .pollVote)
        try expectEqual(pollStepUp.binding.replayAttempt, nil)
    }

    private static func mobileOperationsRepositoryRoutesNotificationsAndQueuesSensitiveActions() async throws {
        let gateway = RecordingMobileOperationsGateway()
        gateway.approvalPage = generatedWorkOrderApprovalItemsPage()
        gateway.errorToThrow = URLError(.notConnectedToInternet)
        let repository = MobileOperationsRepository(
            gateway: gateway,
            cache: InMemoryMobileOperationsCacheStore(),
            notificationStore: InMemoryMobileNotificationStore(),
            sensitiveActionStore: InMemoryMobileSensitiveActionStore(),
            requestIDFactory: FixedRequestIDFactory("mobile-action-1"),
            clock: FixedClock(date: isoDate("2026-06-12T12:30:00Z"))
        )

        let queuedDevice = await repository.registerOrQueuePushDevice(
            deviceID: "ios-device-b",
            appVersion: "0.2.0",
            pushToken: "offline-apns-token"
        )
        try expectEqual(queuedDevice?.actionKind, .deviceRegistration)
        try expectEqual((await repository.sensitiveActionQueueSummary()).readyForReplayCount, 1)

        let routed = await repository.ingestPushNotification(
            MobilePushNotificationPayload(
                id: "push-1",
                title: "긴급 승인",
                body: "승인 대기 항목이 있습니다.",
                category: "approval",
                priority: .critical,
                objectType: "WORK_ORDER",
                objectID: workOrderID,
                receivedAt: isoDate("2026-06-12T12:31:00Z")
            )
        )
        try expectEqual(routed.route, .operationsApproval)
        try expectEqual((await repository.notificationInbox()).urgentUnreadCount, 1)

        let overview = try await repository.refreshOverview()
        let approval = try expectNotNil(MobileOperationsDashboard(snapshot: overview.snapshot).approvals.first)
        let queuedApproval = await repository.queueApprovalDecision(
            approval: approval,
            comment: "확인 후 승인"
        )
        try expectEqual(queuedApproval.status, .waitingForPasskey)
        try expectEqual(gateway.approvedWorkOrders.count, 0)

        gateway.errorToThrow = nil
        let approvalStepUp = generatedMobileStepUpEnvelope(
            actionKind: .approvalDecision,
            objectID: workOrderID,
            reasonKey: .operationsPasskeyApprovalDecision,
            replayAttempt: nil,
            ceremonyID: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
        )
        let submitted = try await repository.approveWorkOrder(
            approval: approval,
            comment: "패스키 확인 승인",
            stepUp: approvalStepUp
        )
        try expectEqual(submitted, nil)
        try expectEqual(gateway.approvedWorkOrders.single()?.workOrderID, workOrderID)
        try expectEqual(gateway.approvedWorkOrders.single()?.comment, "패스키 확인 승인")
        try expectEqual(gateway.approvedWorkOrders.single()?.stepUp.binding, approvalStepUp.binding)

        gateway.errorToThrow = URLError(.timedOut)
        let queuedPing = await repository.recordOnDutyPing(
            state: GPSCollectionState(consentState: .granted, onDuty: true),
            latitude: 37.5665,
            longitude: 126.9780,
            accuracyM: 15,
            recordedAt: isoDate("2026-06-12T12:32:00Z")
        )
        try expectEqual(queuedPing?.actionKind, .onDutyPing)
    }

    private static func mobileOperationsRepositorySubmitsStepUpEnvelopesAndReplaysPerQueuedAttempt() async throws {
        let gateway = RecordingMobileOperationsGateway()
        gateway.approvalPage = generatedWorkOrderApprovalItemsPage()
        let store = InMemoryMobileSensitiveActionStore()
        let repository = MobileOperationsRepository(
            gateway: gateway,
            cache: InMemoryMobileOperationsCacheStore(),
            notificationStore: InMemoryMobileNotificationStore(),
            sensitiveActionStore: store,
            requestIDFactory: SequenceRequestIDFactory(["queued-approval", "queued-poll"]),
            clock: FixedClock(date: isoDate("2026-06-12T12:55:00Z"))
        )

        let overview = try await repository.refreshOverview()
        let approval = try expectNotNil(MobileOperationsDashboard(snapshot: overview.snapshot).approvals.first)
        let approvalStepUp = generatedMobileStepUpEnvelope(
            actionKind: .approvalDecision,
            objectID: workOrderID,
            reasonKey: .operationsPasskeyApprovalDecision,
            replayAttempt: nil,
            ceremonyID: "10000000-0000-4000-8000-000000000001"
        )

        _ = try await repository.approveWorkOrder(
            approval: approval,
            comment: "즉시 승인",
            stepUp: approvalStepUp
        )

        try expectEqual(gateway.approvedWorkOrders.single()?.stepUp.binding, approvalStepUp.binding)

        let pollStepUp = generatedMobileStepUpEnvelope(
            actionKind: .pollVote,
            objectID: pollID,
            reasonKey: .operationsPasskeyPollVote,
            replayAttempt: nil,
            ceremonyID: "10000000-0000-4000-8000-000000000002"
        )
        _ = try await repository.votePoll(pollID: pollID, selectedOptionIDs: [pollOptionID], stepUp: pollStepUp)

        try expectEqual(gateway.pollVoteRequests.single()?.stepUp.binding, pollStepUp.binding)

        _ = await repository.queueApprovalDecision(approval: approval, comment: "대기 승인")
        _ = await repository.queuePollVote(pollID: pollID, selectedOptionIDs: [pollOptionID])

        let summary = await repository.replaySensitiveActions { action, binding in
            try expectEqual(binding, try action.stepUpBinding(replayAttempt: action.nextReplayAttempt))
            let ceremonyID: Components.Schemas.Uuid
            switch action.actionKind {
            case .approvalDecision:
                ceremonyID = "20000000-0000-4000-8000-000000000001"
            case .pollVote:
                ceremonyID = "20000000-0000-4000-8000-000000000002"
            case .mailSend, .workflowStepUp, .deviceRegistration, .onDutyPing:
                throw BehaviorTestFailure("unexpected passkey replay action kind \(action.actionKind.rawValue)")
            }
            return generatedMobileStepUpEnvelope(
                binding: binding,
                ceremonyID: ceremonyID
            )
        }

        try expectEqual(summary, MobileReplaySummary(attempted: 2, submitted: 2, failed: 0, waitingForPasskey: 0))
        try expectEqual(gateway.approvedWorkOrders.count, 2)
        try expectEqual(gateway.pollVoteRequests.count, 2)
        try expectEqual(gateway.approvedWorkOrders.last?.stepUp.binding.replayAttempt, 1)
        try expectEqual(gateway.pollVoteRequests.last?.stepUp.binding.replayAttempt, 1)
        try expectEqual(gateway.approvedWorkOrders.last?.stepUp.assertion.ceremonyId, "20000000-0000-4000-8000-000000000001")
        try expectEqual(gateway.pollVoteRequests.last?.stepUp.assertion.ceremonyId, "20000000-0000-4000-8000-000000000002")
        let remainingActions = await store.pending()
        try expect(remainingActions.isEmpty, "successful replay should mark queued passkey actions submitted")
    }

    private static func mobileOperationsRepositoryRejectsNullStaleAndReplayedStepUpAssertions() async throws {
        let gateway = RecordingMobileOperationsGateway()
        gateway.approvalPage = generatedWorkOrderApprovalItemsPage()
        let store = InMemoryMobileSensitiveActionStore()
        let repository = MobileOperationsRepository(
            gateway: gateway,
            cache: InMemoryMobileOperationsCacheStore(),
            notificationStore: InMemoryMobileNotificationStore(),
            sensitiveActionStore: store,
            requestIDFactory: SequenceRequestIDFactory(["null-approval", "null-poll"]),
            clock: FixedClock(date: isoDate("2026-06-12T13:05:00Z"))
        )
        let overview = try await repository.refreshOverview()
        let approval = try expectNotNil(MobileOperationsDashboard(snapshot: overview.snapshot).approvals.first)

        let queuedApproval = try await repository.approveWorkOrder(
            approval: approval,
            comment: "패스키 필요 승인",
            stepUp: nil
        )
        let queuedPoll = try await repository.votePoll(
            pollID: pollID,
            selectedOptionIDs: [pollOptionID],
            stepUp: nil
        )

        try expectEqual(try expectNotNil(queuedApproval).status, .waitingForPasskey)
        try expectEqual(try expectNotNil(queuedPoll).status, .waitingForPasskey)
        try expectEqual((await repository.sensitiveActionQueueSummary()).pendingPasskeyCount, 2)
        try expect(gateway.approvedWorkOrders.isEmpty, "nil approval step-up must queue instead of mutating the API")
        try expect(gateway.pollVoteRequests.isEmpty, "nil poll step-up must queue instead of mutating the API")

        _ = try await expectAsyncThrows {
            try await repository.approveWorkOrder(
                approval: approval,
                comment: "즉시 승인에 재생 바인딩 재사용",
                stepUp: generatedMobileStepUpEnvelope(
                    actionKind: .approvalDecision,
                    objectID: workOrderID,
                    reasonKey: .operationsPasskeyApprovalDecision,
                    replayAttempt: 1,
                    ceremonyID: "30000000-0000-4000-8000-000000000001"
                )
            )
        }
        _ = try await expectAsyncThrows {
            try await repository.votePoll(
                pollID: pollID,
                selectedOptionIDs: [pollOptionID],
                stepUp: generatedMobileStepUpEnvelope(
                    actionKind: .approvalDecision,
                    objectID: workOrderID,
                    reasonKey: .operationsPasskeyApprovalDecision,
                    replayAttempt: nil,
                    ceremonyID: "30000000-0000-4000-8000-000000000002"
                )
            )
        }
        _ = try await expectAsyncThrows {
            try await repository.votePoll(
                pollID: pollID,
                selectedOptionIDs: [pollOptionID],
                stepUp: generatedMobileStepUpEnvelope(
                    actionKind: .pollVote,
                    objectID: pollID,
                    reasonKey: .operationsPasskeyPollVote,
                    replayAttempt: nil,
                    ceremonyID: "00000000-0000-0000-0000-000000000000"
                )
            )
        }

        try expectEqual((await store.pending()).count { $0.status == .waitingForPasskey }, 2)
        try expect(gateway.approvedWorkOrders.isEmpty, "invalid approval step-up must fail closed before API mutation")
        try expect(gateway.pollVoteRequests.isEmpty, "invalid poll step-up must fail closed before API mutation")

        let approvalBinding = try repository.stepUpBinding(actionKind: .approvalDecision, objectID: workOrderID)
        let pollBinding = try repository.stepUpBinding(actionKind: .pollVote, objectID: pollID)
        let submittedApproval = try await repository.approveWorkOrder(
            approval: approval,
            comment: "신규 패스키 승인",
            stepUp: generatedMobileStepUpEnvelope(binding: approvalBinding, ceremonyID: "30000000-0000-4000-8000-000000000003")
        )
        let submittedPoll = try await repository.votePoll(
            pollID: pollID,
            selectedOptionIDs: [pollOptionID],
            stepUp: generatedMobileStepUpEnvelope(binding: pollBinding, ceremonyID: "30000000-0000-4000-8000-000000000004")
        )

        try expectEqual(submittedApproval, nil)
        try expectEqual(submittedPoll, nil)
        try expectEqual(gateway.approvedWorkOrders.single()?.stepUp.binding, approvalBinding)
        try expectEqual(gateway.pollVoteRequests.single()?.stepUp.binding, pollBinding)
        try expectEqual(approvalBinding.reasonKey, .operationsPasskeyApprovalDecision)
        try expectEqual(pollBinding.reasonKey, .operationsPasskeyPollVote)

        let replayGateway = RecordingMobileOperationsGateway()
        let replayStore = InMemoryMobileSensitiveActionStore()
        let replayRepository = MobileOperationsRepository(
            gateway: replayGateway,
            cache: InMemoryMobileOperationsCacheStore(),
            notificationStore: InMemoryMobileNotificationStore(),
            sensitiveActionStore: replayStore,
            requestIDFactory: SequenceRequestIDFactory(["replay-approval", "replay-poll"]),
            clock: FixedClock(date: isoDate("2026-06-12T13:10:00Z"))
        )
        let replayApproval = MobileApprovalRow(item: try expectNotNil(generatedWorkOrderApprovalItemsPage().items.single()))
        _ = await replayRepository.queueApprovalDecision(
            approval: replayApproval,
            comment: "재생 승인",
            status: .waitingForPasskey,
            nextReplayAttempt: 2
        )
        _ = await replayRepository.queuePollVote(
            pollID: pollID,
            selectedOptionIDs: [pollOptionID],
            status: .waitingForPasskey,
            nextReplayAttempt: 2
        )

        let staleReplay = await replayRepository.replaySensitiveActions { action, _ in
            let staleBinding: Components.Schemas.MobilePasskeyStepUpBinding
            switch action.actionKind {
            case .approvalDecision:
                staleBinding = try action.stepUpBinding(replayAttempt: 1)
            case .pollVote:
                staleBinding = try action.stepUpBinding(replayAttempt: nil)
            case .mailSend, .workflowStepUp, .deviceRegistration, .onDutyPing:
                throw BehaviorTestFailure("unexpected passkey replay action kind \(action.actionKind.rawValue)")
            }
            return generatedMobileStepUpEnvelope(binding: staleBinding, ceremonyID: "40000000-0000-4000-8000-000000000001")
        }

        try expectEqual(staleReplay, MobileReplaySummary(attempted: 2, submitted: 0, failed: 0, waitingForPasskey: 2))
        try expect(replayGateway.approvedWorkOrders.isEmpty, "stale replay approval must not mutate the API")
        try expect(replayGateway.pollVoteRequests.isEmpty, "replayed poll assertion must not mutate the API")
        let waitingAfterStaleReplay = await replayStore.pending()
        try expectEqual(waitingAfterStaleReplay.count, 2)
        try expect(
            waitingAfterStaleReplay.allSatisfy { $0.status == .waitingForPasskey && ($0.lastError?.contains("binding mismatch") ?? false) },
            "stale/replayed assertions should keep queued actions waiting with a closed-fail error"
        )

        let nullReplay = await replayRepository.replaySensitiveActions { _, _ in nil }

        try expectEqual(nullReplay, MobileReplaySummary(attempted: 2, submitted: 0, failed: 0, waitingForPasskey: 2))
        try expect(replayGateway.approvedWorkOrders.isEmpty, "nil replay approval step-up must keep waiting")
        try expect(replayGateway.pollVoteRequests.isEmpty, "nil replay poll step-up must keep waiting")

        let freshReplay = await replayRepository.replaySensitiveActions { action, binding in
            try expectEqual(binding, try action.stepUpBinding(replayAttempt: action.nextReplayAttempt))
            let ceremonyID: Components.Schemas.Uuid
            switch action.actionKind {
            case .approvalDecision:
                ceremonyID = "40000000-0000-4000-8000-000000000002"
            case .pollVote:
                ceremonyID = "40000000-0000-4000-8000-000000000003"
            case .mailSend, .workflowStepUp, .deviceRegistration, .onDutyPing:
                throw BehaviorTestFailure("unexpected passkey replay action kind \(action.actionKind.rawValue)")
            }
            return generatedMobileStepUpEnvelope(binding: binding, ceremonyID: ceremonyID)
        }

        try expectEqual(freshReplay, MobileReplaySummary(attempted: 2, submitted: 2, failed: 0, waitingForPasskey: 0))
        let expectedApprovalReplayBinding = try MobileOperationsRepository.stepUpBinding(
            actionKind: .approvalDecision,
            objectID: workOrderID,
            replayAttempt: 2
        )
        let expectedPollReplayBinding = try MobileOperationsRepository.stepUpBinding(
            actionKind: .pollVote,
            objectID: pollID,
            replayAttempt: 2
        )
        try expectEqual(replayGateway.approvedWorkOrders.single()?.stepUp.binding, expectedApprovalReplayBinding)
        try expectEqual(replayGateway.pollVoteRequests.single()?.stepUp.binding, expectedPollReplayBinding)
        let remainingAfterFreshReplay = await replayStore.pending()
        try expect(remainingAfterFreshReplay.isEmpty, "successful fresh replay should mark queued step-up actions submitted")
    }

    private static func mobileOperationsRepositoryDurableStoresSurviveReconstruction() async throws {
        let root = try temporaryMobileOperationsStoreRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let snapshotURL = root.appendingPathComponent("overview.json")
        let inboxURL = root.appendingPathComponent("notifications.json")
        let actionURL = root.appendingPathComponent("actions.json")

        let gateway = RecordingMobileOperationsGateway()
        let firstActionStore = try FileMobileSensitiveActionStore(fileURL: actionURL)
        let firstRepository = MobileOperationsRepository(
            gateway: gateway,
            cache: try FileMobileOperationsCacheStore(fileURL: snapshotURL),
            notificationStore: try FileMobileNotificationStore(fileURL: inboxURL),
            sensitiveActionStore: firstActionStore,
            requestIDFactory: SequenceRequestIDFactory(["approval-action", "device-action", "location-action"]),
            clock: FixedClock(date: isoDate("2026-06-12T12:45:00Z"))
        )

        _ = try await firstRepository.refreshOverview()
        _ = await firstRepository.ingestPushNotification(
            MobilePushNotificationPayload(
                id: "push-durable-1",
                title: "승인 알림",
                body: "오프라인 후에도 읽음 상태가 유지되어야 합니다.",
                category: "approval",
                priority: .high,
                objectType: "WORK_ORDER",
                objectID: workOrderID,
                receivedAt: isoDate("2026-06-12T12:44:00Z")
            )
        )
        _ = await firstRepository.markNotificationRead(id: "push-durable-1")

        let approvalItem = try expectNotNil(generatedWorkOrderApprovalItemsPage().items.single())
        _ = await firstRepository.queueApprovalDecision(
            approval: MobileApprovalRow(item: approvalItem),
            comment: "  승인 대기  "
        )
        gateway.errorToThrow = URLError(.notConnectedToInternet)
        _ = await firstRepository.registerOrQueuePushDevice(
            deviceID: "ios-device-durable",
            appVersion: "0.3.0",
            pushToken: "durable-apns-token"
        )
        gateway.errorToThrow = URLError(.timedOut)
        _ = await firstRepository.recordOnDutyPing(
            state: GPSCollectionState(consentState: .granted, onDuty: true),
            latitude: 37.5665,
            longitude: 126.9780,
            accuracyM: 12,
            recordedAt: isoDate("2026-06-12T12:46:00Z")
        )

        let reopenedActionStore = try FileMobileSensitiveActionStore(fileURL: actionURL)
        let reopenedRepository = MobileOperationsRepository(
            gateway: RecordingMobileOperationsGateway(),
            cache: try FileMobileOperationsCacheStore(fileURL: snapshotURL),
            notificationStore: try FileMobileNotificationStore(fileURL: inboxURL),
            sensitiveActionStore: reopenedActionStore,
            requestIDFactory: SequenceRequestIDFactory([]),
            clock: FixedClock(date: isoDate("2026-06-12T12:50:00Z"))
        )

        let cachedOverview = try expectNotNil(await reopenedRepository.cachedOverview())
        try expectEqual(cachedOverview.snapshot.mailThreads.single()?.id, mailThreadID)
        try expectEqual(cachedOverview.snapshot.polls.single()?.id, pollID)

        let inbox = await reopenedRepository.notificationInbox()
        try expectEqual(inbox.notifications.single()?.id, "push-durable-1")
        try expectEqual(inbox.notifications.single()?.readAt, isoDate("2026-06-12T12:45:00Z"))
        try expectEqual(inbox.unreadCount, 0)

        let summary = await reopenedRepository.sensitiveActionQueueSummary()
        try expectEqual(summary.pendingPasskeyCount, 1)
        try expectEqual(summary.readyForReplayCount, 2)

        let reopenedActions = await reopenedActionStore.pending()
        let approvalAction = try expectNotNil(reopenedActions.first { $0.actionKind == .approvalDecision })
        try expectEqual(approvalAction.id, "approval-action")
        try expectEqual(approvalAction.objectID, workOrderID)
        try expectEqual(approvalAction.comment, "승인 대기")
        try expectEqual(approvalAction.status, .waitingForPasskey)

        let deviceAction = try expectNotNil(reopenedActions.first { $0.actionKind == .deviceRegistration })
        try expectEqual(deviceAction.id, "device-action")
        try expectEqual(deviceAction.deviceID, "ios-device-durable")
        try expectEqual(deviceAction.appVersion, "0.3.0")
        try expectEqual(deviceAction.pushToken, "durable-apns-token")
        try expectEqual(deviceAction.status, .readyForReplay)

        let pingAction = try expectNotNil(reopenedActions.first { $0.actionKind == .onDutyPing })
        try expectEqual(pingAction.id, "location-action")
        try expectEqual(pingAction.locationPing?.latitude, 37.5665)
        try expectEqual(pingAction.locationPing?.recordedAt, isoDate("2026-06-12T12:46:00Z"))
        try expectEqual(pingAction.status, .readyForReplay)
    }

    private static func evidenceUploadTransportFailuresStayPendingForRetry() async throws {
        let root = try temporaryEvidenceStoreRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let fileURL = root.appendingPathComponent("retry-evidence.jpg")
        try Data([0x01, 0x02, 0x03]).write(to: fileURL)
        let store = InMemoryEvidenceUploadStore()
        await store.upsert(
            PendingEvidenceUpload(
                id: "evidence-retry",
                workOrderID: workOrderID,
                fileURL: fileURL,
                contentType: "image/jpeg",
                sizeBytes: 3,
                checksumSHA256: "checksum"
            )
        )
        let gateway = RecordingEvidenceMaintenanceGateway()
        gateway.errorToThrow = URLError(.timedOut)
        let now = isoDate("2026-06-12T13:00:00Z")
        let repository = EvidenceRepository(
            gateway: gateway,
            store: store,
            clock: FixedClock(date: now)
        )

        let summary = try await repository.uploadPending()

        try expectEqual(summary.attempted, 1)
        try expectEqual(summary.uploaded, 0)
        try expectEqual(summary.retrying, 1)
        try expectEqual(summary.failed, 0)
        let retrying = try expectNotNil(await store.get(id: "evidence-retry"))
        try expectEqual(retrying.syncState, .pending)
        try expectEqual((await store.pending()).single()?.id, "evidence-retry")
        try expect(retrying.lastError?.isEmpty == false, "retrying evidence should keep the last transport error")
        try expect(retrying.isRetrying, "retrying evidence should be visible as retrying, not terminal failed")
        try expectEqual(retrying.retryAttemptCount, 1)
        try expectEqual(retrying.nextRetryAt, now.addingTimeInterval(60))

        let throttled = try await repository.uploadPending()

        try expectEqual(throttled.attempted, 0)
        try expectEqual(throttled.retrying, 0)
        try expectEqual(throttled.failed, 0)
        try expectEqual(gateway.presignRequests.count, 1)
    }

    private static func evidenceUploadReplaysCustomPresignedHeaders() async throws {
        let request = try await uploadRequestForPresignedEvidenceHeaders([
            try presignedUploadHeader("x-amz-meta-maintenance-evidence", "signed-evidence-42"),
        ])

        try expectEqual(
            request.value(forHTTPHeaderField: "x-amz-meta-maintenance-evidence"),
            "signed-evidence-42"
        )
    }

    private static func evidenceUploadReplaysPresignedContentTypeExactly() async throws {
        let request = try await uploadRequestForPresignedEvidenceHeaders(
            [try presignedUploadHeader("Content-Type", "application/octet-stream")],
            localContentType: "image/jpeg"
        )

        try expectEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/octet-stream")
    }

    private static func evidenceUploadDoesNotInventContentTypeWhenPresignOmitsIt() async throws {
        let request = try await uploadRequestForPresignedEvidenceHeaders(
            [try presignedUploadHeader("x-amz-content-sha256", "UNSIGNED-PAYLOAD")],
            localContentType: "image/png"
        )

        try expectEqual(request.value(forHTTPHeaderField: "Content-Type"), nil)
    }

    private static func uploadRequestForPresignedEvidenceHeaders(
        _ headers: [OpenAPIArrayContainer],
        localContentType: String = "image/jpeg"
    ) async throws -> URLRequest {
        let root = try temporaryEvidenceStoreRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let fileURL = root.appendingPathComponent("header-evidence.bin")
        let data = Data([0x11, 0x22, 0x33])
        try data.write(to: fileURL)

        EvidenceUploadURLProtocol.setStatusCodes([200])
        defer { EvidenceUploadURLProtocol.setStatusCodes([]) }
        let store = InMemoryEvidenceUploadStore()
        await store.upsert(
            PendingEvidenceUpload(
                id: "evidence-header-replay",
                workOrderID: workOrderID,
                fileURL: fileURL,
                contentType: localContentType,
                sizeBytes: Int64(data.count),
                checksumSHA256: "checksum"
            )
        )
        let gateway = RecordingEvidenceMaintenanceGateway()
        gateway.uploadHeaders = headers
        let repository = EvidenceRepository(
            gateway: gateway,
            store: store,
            urlSession: evidenceUploadURLSession(),
            clock: FixedClock(date: isoDate("2026-06-12T13:08:00Z"))
        )

        let summary = try await repository.uploadPending()

        try expectEqual(summary.attempted, 1)
        try expectEqual(summary.uploaded, 1)
        try expectEqual(summary.retrying, 0)
        try expectEqual(summary.failed, 0)
        try expectEqual(gateway.presignRequests.count, 1)
        return try expectNotNil(EvidenceUploadURLProtocol.recordedRequests().single())
    }

    private static func presignedUploadHeader(_ name: String, _ value: String) throws -> OpenAPIArrayContainer {
        try OpenAPIArrayContainer(unvalidatedValue: [name, value])
    }

    private static func evidenceUploadRetryReplaySucceedsAndClearsPendingItem() async throws {
        let root = try temporaryEvidenceStoreRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let fileURL = root.appendingPathComponent("replay-evidence.jpg")
        try Data([0x04, 0x05, 0x06]).write(to: fileURL)
        EvidenceUploadURLProtocol.setStatusCodes([200])
        defer { EvidenceUploadURLProtocol.setStatusCodes([]) }
        let store = InMemoryEvidenceUploadStore()
        await store.upsert(
            PendingEvidenceUpload(
                id: "evidence-replay",
                workOrderID: workOrderID,
                fileURL: fileURL,
                contentType: "image/jpeg",
                sizeBytes: 3,
                checksumSHA256: "checksum"
            )
        )
        let gateway = RecordingEvidenceMaintenanceGateway()
        gateway.errorToThrow = URLError(.notConnectedToInternet)
        let now = isoDate("2026-06-12T13:10:00Z")
        let clock = MutableClock(date: now)
        let repository = EvidenceRepository(
            gateway: gateway,
            store: store,
            urlSession: evidenceUploadURLSession(),
            clock: clock
        )

        _ = try await repository.uploadPending()
        clock.date = now.addingTimeInterval(61)
        let replay = try await repository.uploadPending()

        try expectEqual(replay.attempted, 1)
        try expectEqual(replay.uploaded, 1)
        try expectEqual(replay.retrying, 0)
        try expectEqual(replay.failed, 0)
        let synced = try expectNotNil(await store.get(id: "evidence-replay"))
        try expectEqual(synced.syncState, .synced)
        try expectEqual(synced.lastError, nil)
        try expectEqual(synced.retryAttemptCount, 0)
        try expectEqual(synced.nextRetryAt, nil)
        let pendingAfterReplay = await store.pending()
        try expect(pendingAfterReplay.isEmpty, "successful evidence replay should clear the pending retry item")
        try expectEqual(gateway.presignRequests.count, 2)
    }

    private static func evidenceUploadPermanentFileFailuresBecomeTerminal() async throws {
        let root = try temporaryEvidenceStoreRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let missingFileURL = root.appendingPathComponent("missing-evidence.jpg")
        let store = InMemoryEvidenceUploadStore()
        await store.upsert(
            PendingEvidenceUpload(
                id: "evidence-terminal",
                workOrderID: workOrderID,
                fileURL: missingFileURL,
                contentType: "image/jpeg",
                sizeBytes: 3,
                checksumSHA256: "checksum"
            )
        )
        let gateway = RecordingEvidenceMaintenanceGateway()
        let repository = EvidenceRepository(
            gateway: gateway,
            store: store,
            clock: FixedClock(date: isoDate("2026-06-12T13:05:00Z"))
        )

        let summary = try await repository.uploadPending()

        try expectEqual(summary.attempted, 1)
        try expectEqual(summary.uploaded, 0)
        try expectEqual(summary.retrying, 0)
        try expectEqual(summary.failed, 1)
        let pendingAfterTerminalFailure = await store.pending()
        try expect(pendingAfterTerminalFailure.isEmpty, "terminal evidence failures should leave the pending upload set empty")
        let failed = try expectNotNil(await store.get(id: "evidence-terminal"))
        try expectEqual(failed.syncState, .failed)
        try expect(failed.lastError?.isEmpty == false, "terminal evidence failure should expose a permanent reason")
        try expect(!failed.isRetrying, "terminal evidence failure should not look retryable")
        try expectEqual(failed.nextRetryAt, nil)
        try expectEqual(gateway.presignRequests.count, 0)
    }

    private static func fileBackedOfflineStoresRejectCorruptJSONWithoutDiscardingQueuedData() async throws {
        let root = try temporaryEvidenceStoreRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let corruptData = Data("{ not-valid-json".utf8)

        let evidenceQueueURL = root.appendingPathComponent("corrupt-evidence-queue.json")
        try corruptData.write(to: evidenceQueueURL)
        try expectPersistenceFailure(.corruptJSON("evidence_upload")) {
            _ = try FileEvidenceUploadStore(fileURL: evidenceQueueURL)
        }
        try expectEqual(try Data(contentsOf: evidenceQueueURL), corruptData)

        let messengerOutboxURL = root.appendingPathComponent("corrupt-messenger-outbox.json")
        try corruptData.write(to: messengerOutboxURL)
        try expectPersistenceFailure(.corruptJSON("messenger_outbox")) {
            _ = try FileMessengerOutboxStore(fileURL: messengerOutboxURL)
        }
        try expectEqual(try Data(contentsOf: messengerOutboxURL), corruptData)
    }

    private static func fileBackedOfflineStoresSurfaceWriteFailuresWithoutMutatingMemory() async throws {
        let root = try temporaryEvidenceStoreRoot()
        defer { try? FileManager.default.removeItem(at: root) }

        let evidenceStore = try FileEvidenceUploadStore(
            fileURL: root.appendingPathComponent("missing-evidence-parent/evidence-queue.json")
        )
        try await expectPersistenceFailureAsync(.writeFailed("evidence_upload")) {
            try await evidenceStore.upsert(
                PendingEvidenceUpload(
                    id: "evidence-write-failure",
                    workOrderID: workOrderID,
                    fileURL: root.appendingPathComponent("evidence.jpg"),
                    contentType: "image/jpeg",
                    sizeBytes: 3,
                    checksumSHA256: "checksum"
                )
            )
        }
        let pendingEvidenceAfterWriteFailure = try await evidenceStore.pending()
        try expect(pendingEvidenceAfterWriteFailure.isEmpty, "failed evidence writes must not mutate memory as queued")

        let messengerStore = try FileMessengerOutboxStore(
            fileURL: root.appendingPathComponent("missing-outbox-parent/messenger-outbox.json")
        )
        try await expectPersistenceFailureAsync(.writeFailed("messenger_outbox")) {
            try await messengerStore.upsert(
                QueuedMessengerMessage(
                    requestID: "message-write-failure",
                    threadID: messengerThreadID,
                    body: "오프라인 작성",
                    attachmentEvidenceIDs: [],
                    createdAt: isoDate("2026-06-12T09:30:00Z")
                )
            )
        }
        let pendingMessagesAfterWriteFailure = try await messengerStore.pending()
        try expect(pendingMessagesAfterWriteFailure.isEmpty, "failed outbox writes must not mutate memory as queued")
    }

    private static func coreDataMutationQueueSurfacesFetchFailuresInsteadOfEmptyPending() async throws {
        let storeURL = try temporaryOfflineQueueStoreURL()
        defer { try? FileManager.default.removeItem(at: storeURL.deletingLastPathComponent()) }
        let store = try CoreDataMutationQueueStore(storeURL: storeURL, testingFailureMode: .fetch)

        try await expectPersistenceFailureAsync(.fetchFailed("mutation_queue")) {
            _ = try await store.pending()
        }

        let repository = OfflineQueueRepository(
            store: store,
            syncGateway: RecordingSyncGateway(),
            deviceIDProvider: { "device-a" },
            requestIDFactory: FixedRequestIDFactory("fetch-failure-request"),
            syncIDFactory: FixedRequestIDFactory("fetch-failure-sync"),
            clock: FixedClock(date: isoDate("2026-06-12T10:30:00Z"))
        )
        try await expectPersistenceFailureAsync(.fetchFailed("mutation_queue")) {
            _ = try await repository.replayPending()
        }
    }

    private static func coreDataMutationQueueSurfacesSaveFailuresInsteadOfReturningQueuedSuccess() async throws {
        let storeURL = try temporaryOfflineQueueStoreURL()
        defer { try? FileManager.default.removeItem(at: storeURL.deletingLastPathComponent()) }
        let store = try CoreDataMutationQueueStore(storeURL: storeURL, testingFailureMode: .save)

        try await expectPersistenceFailureAsync(.saveFailed("mutation_queue")) {
            try await store.upsert(
                QueuedMutation(
                    requestID: "save-failure-request",
                    kind: .workOrderStart,
                    workOrderID: workOrderID,
                    createdAt: isoDate("2026-06-12T10:40:00Z")
                )
            )
        }

        let repository = OfflineQueueRepository(
            store: store,
            syncGateway: RecordingSyncGateway(),
            deviceIDProvider: { "device-a" },
            requestIDFactory: FixedRequestIDFactory("save-failure-enqueue"),
            syncIDFactory: FixedRequestIDFactory("save-failure-sync"),
            clock: FixedClock(date: isoDate("2026-06-12T10:45:00Z"))
        )
        try await expectPersistenceFailureAsync(.saveFailed("mutation_queue")) {
            _ = try await repository.enqueueStart(workOrderID: workOrderID)
        }
    }

    private static func offlineStartRetriesSameRequestIDAndAcceptsCachedSyncResult() async throws {
        let store = InMemoryMutationQueueStore()
        let sync = RecordingSyncGateway()
        let repository = OfflineQueueRepository(
            store: store,
            syncGateway: sync,
            deviceIDProvider: { "device-a" },
            requestIDFactory: FixedRequestIDFactory("01HVSTART000000000000000000"),
            syncIDFactory: FixedRequestIDFactory("sync-a"),
            clock: FixedClock(date: isoDate("2026-06-12T09:00:00Z"))
        )

        let requestID = try await repository.enqueueStart(workOrderID: workOrderID)

        try expectEqual(requestID, "01HVSTART000000000000000000")
        try expectEqual(await store.get(requestID)?.syncState, .pending)

        sync.errorToThrow = URLError(.notConnectedToInternet)
        let offlineSummary = try await repository.replayPending()

        try expectEqual(offlineSummary, ReplaySummary(attempted: 1, applied: 0, failed: 1, cached: 0))
        let pendingAfterTransportFailure = await store.pending()
        try expectEqual(pendingAfterTransportFailure.single()?.requestID, requestID)

        sync.errorToThrow = nil
        sync.nextResponse = Components.Schemas.SyncBatchResponse(
            syncId: "sync-a",
            results: [
                Components.Schemas.SyncOperationResult(
                    requestId: requestID,
                    operation: .workOrderStart,
                    status: .applied,
                    httpStatus: 200,
                    result: summary(status: .inProgress),
                    replayed: true
                ),
            ]
        )

        let cachedSummary = try await repository.replayPending()

        try expectEqual(cachedSummary, ReplaySummary(attempted: 1, applied: 1, failed: 0, cached: 1))
        try expectEqual(await store.get(requestID)?.isSynced, true)
        try expectEqual(sync.requests.compactMap { $0.operations.single()?.requestId }, [requestID])
        try expectEqual(sync.deviceIDs, ["device-a"])
    }

    private static func failedOperationSurfacesQueueResultWithoutDroppingMutation() async throws {
        let store = InMemoryMutationQueueStore()
        let sync = RecordingSyncGateway()
        let repository = OfflineQueueRepository(
            store: store,
            syncGateway: sync,
            deviceIDProvider: { "device-a" },
            requestIDFactory: FixedRequestIDFactory("01HVREPORT0000000000000000"),
            syncIDFactory: FixedRequestIDFactory("sync-b"),
            clock: FixedClock(date: isoDate("2026-06-12T10:00:00Z"))
        )

        let requestID = try await repository.enqueueReport(
            workOrderID: workOrderID,
            resultType: .temporaryAction,
            diagnosis: "유압 누유",
            actionTaken: "호스 교체 전 임시 조치"
        )
        sync.nextResponse = Components.Schemas.SyncBatchResponse(
            syncId: "sync-b",
            results: [
                Components.Schemas.SyncOperationResult(
                    requestId: requestID,
                    operation: .workOrderReport,
                    status: .failed,
                    httpStatus: 409,
                    error: Components.Schemas.SyncError(code: "conflict", message: "server wins"),
                    replayed: false
                ),
            ]
        )

        let summary = try await repository.replayPending()

        try expectEqual(summary, ReplaySummary(attempted: 1, applied: 0, failed: 1, cached: 0))
        try expectEqual(await store.get(requestID)?.syncState, .failed)
        let lastError = await store.get(requestID)?.lastError ?? ""
        try expect(lastError.isEmpty == false, "failed mutation should retain server error")
    }

    private static func workOrderRepositoryQueuesOnlyTransportFailuresForStartAndReport() async throws {
        let permanentStatusCodes = [401, 403, 404, 409, 422, 500]
        for statusCode in permanentStatusCodes {
            let startGateway = RecordingEvidenceMaintenanceGateway()
            startGateway.startError = MaintenanceGatewayError.apiResponse(
                operation: "startWorkOrder",
                statusCode: statusCode
            )
            let (startRepository, startStore) = workOrderRepositoryFixture(
                gateway: startGateway,
                requestIDs: ["start-http-\(statusCode)"]
            )

            _ = try await expectAsyncThrows {
                try await startRepository.start(id: workOrderID)
            }
            let queuedStartsAfterHTTPFailure = await startStore.pending()
            try expect(
                queuedStartsAfterHTTPFailure.isEmpty,
                "HTTP \(statusCode) start failure must not create an offline mutation"
            )

            let reportGateway = RecordingEvidenceMaintenanceGateway()
            reportGateway.reportError = MaintenanceGatewayError.apiResponse(
                operation: "submitWorkOrderReport",
                statusCode: statusCode
            )
            let (reportRepository, reportStore) = workOrderRepositoryFixture(
                gateway: reportGateway,
                requestIDs: ["report-http-\(statusCode)"]
            )

            _ = try await expectAsyncThrows {
                try await reportRepository.submitReport(id: workOrderID, draft: reportDraft())
            }
            let queuedReportsAfterHTTPFailure = await reportStore.pending()
            try expect(
                queuedReportsAfterHTTPFailure.isEmpty,
                "HTTP \(statusCode) report failure must not create an offline mutation"
            )
        }

        let permanentProtocolFailures: [(label: String, error: Error)] = [
            (
                "http-500-contract",
                MaintenanceGatewayError.temporaryServerFailure(
                    statusCode: 500,
                    message: "start/report returned HTTP 500"
                )
            ),
            ("tls-configuration", URLError(.secureConnectionFailed)),
        ]
        for failure in permanentProtocolFailures {
            let startGateway = RecordingEvidenceMaintenanceGateway()
            startGateway.startError = failure.error
            let (startRepository, startStore) = workOrderRepositoryFixture(
                gateway: startGateway,
                requestIDs: ["start-\(failure.label)"]
            )

            _ = try await expectAsyncThrows {
                try await startRepository.start(id: workOrderID)
            }
            let queuedStartsAfterPermanentFailure = await startStore.pending()
            try expect(
                queuedStartsAfterPermanentFailure.isEmpty,
                "\(failure.label) start failure must not create an offline mutation"
            )

            let reportGateway = RecordingEvidenceMaintenanceGateway()
            reportGateway.reportError = failure.error
            let (reportRepository, reportStore) = workOrderRepositoryFixture(
                gateway: reportGateway,
                requestIDs: ["report-\(failure.label)"]
            )

            _ = try await expectAsyncThrows {
                try await reportRepository.submitReport(id: workOrderID, draft: reportDraft())
            }
            let queuedReportsAfterPermanentFailure = await reportStore.pending()
            try expect(
                queuedReportsAfterPermanentFailure.isEmpty,
                "\(failure.label) report failure must not create an offline mutation"
            )
        }

        let offlineStartGateway = RecordingEvidenceMaintenanceGateway()
        offlineStartGateway.startError = URLError(.notConnectedToInternet)
        let (offlineStartRepository, offlineStartStore) = workOrderRepositoryFixture(
            gateway: offlineStartGateway,
            requestIDs: ["start-transport"]
        )

        try expectEqual(try await offlineStartRepository.start(id: workOrderID), .pending)
        let queuedStart = try expectNotNil((await offlineStartStore.pending()).single())
        try expectEqual(queuedStart.requestID, "start-transport")
        try expectEqual(queuedStart.kind, .workOrderStart)

        let offlineReportGateway = RecordingEvidenceMaintenanceGateway()
        offlineReportGateway.reportError = URLError(.timedOut)
        let (offlineReportRepository, offlineReportStore) = workOrderRepositoryFixture(
            gateway: offlineReportGateway,
            requestIDs: ["report-transport"]
        )

        try expectEqual(
            try await offlineReportRepository.submitReport(id: workOrderID, draft: reportDraft()),
            .pending
        )
        let queuedReport = try expectNotNil((await offlineReportStore.pending()).single())
        try expectEqual(queuedReport.requestID, "report-transport")
        try expectEqual(queuedReport.kind, .workOrderReport)
        try expectEqual(queuedReport.diagnosis, "배터리 단선")
        try expectEqual(queuedReport.actionTaken, "케이블 교체")
    }

    private static func workOrderRepositoryDoesNotQueueWhenPostSuccessDetailRefreshFails() async throws {
        let startGateway = RecordingEvidenceMaintenanceGateway()
        startGateway.detailError = URLError(.notConnectedToInternet)
        let (startRepository, startStore) = workOrderRepositoryFixture(
            gateway: startGateway,
            requestIDs: ["start-detail-refresh"]
        )

        _ = try await expectAsyncThrows {
            try await startRepository.start(id: workOrderID)
        }
        try expectEqual(startGateway.startedWorkOrderIDs, [workOrderID])
        let queuedStartsAfterDetailFailure = await startStore.pending()
        try expect(
            queuedStartsAfterDetailFailure.isEmpty,
            "detail refresh failure after a successful start must not create an offline mutation"
        )

        let reportGateway = RecordingEvidenceMaintenanceGateway()
        reportGateway.detailError = URLError(.networkConnectionLost)
        let (reportRepository, reportStore) = workOrderRepositoryFixture(
            gateway: reportGateway,
            requestIDs: ["report-detail-refresh"]
        )

        _ = try await expectAsyncThrows {
            try await reportRepository.submitReport(id: workOrderID, draft: reportDraft())
        }
        try expectEqual(reportGateway.submittedReportIDs, [workOrderID])
        let queuedReportsAfterDetailFailure = await reportStore.pending()
        try expect(
            queuedReportsAfterDetailFailure.isEmpty,
            "detail refresh failure after a successful report must not create an offline mutation"
        )
    }

    private static func messengerMappersAndReducerMirrorAndroidModels() throws {
        let thread = generatedMessengerThread()
        let first = generatedMessengerMessage(id: firstMessageID, body: "초기 점검", minute: 10)
        let second = generatedMessengerMessage(id: secondMessageID, body: "현장 도착", minute: 12)
        let reducer = MessengerReducer()

        let loaded = reducer.reduce(
            MessengerState(),
            .messagesPageLoaded(
                threadID: messengerThreadID,
                page: MessengerMessagePage(
                    items: [second.toMessengerMessage(), first.toMessengerMessage()],
                    nextCursor: firstMessageID
                )
            )
        )
        let live = reducer.reduce(
            MessengerState(
                threads: [thread.toMessengerThread()],
                messagesByThread: loaded.messagesByThread,
                nextCursorByThread: loaded.nextCursorByThread,
                lastMessageIDByThread: loaded.lastMessageIDByThread
            ),
            .liveMessageReceived(second.toMessengerMessage())
        )

        try expectEqual(thread.toMessengerThread().title, "팀 채널")
        try expectEqual(live.messagesByThread[messengerThreadID]?.map { $0.body }, ["초기 점검", "현장 도착"])
        try expectEqual(live.lastMessageIDByThread[messengerThreadID], secondMessageID)
        try expectEqual(live.resumeCursor(), secondMessageID)
    }

    private static func offlineComposedMessagesQueueAndReplayDirectly() async throws {
        let store = InMemoryMessengerOutboxStore()
        let gateway = RecordingMessengerGateway()
        let repository = MessengerRepository(
            gateway: gateway,
            outbox: store,
            requestIDFactory: FixedMessengerRequestIDFactory("chat-request-1"),
            clock: FixedClock(date: isoDate("2026-06-12T09:00:00Z"))
        )

        gateway.errorToThrow = URLError(.notConnectedToInternet)
        let queued = try await repository.sendOrQueue(
            threadID: messengerThreadID,
            body: "오프라인 작성",
            attachmentEvidenceIDs: []
        )

        try expectEqual(queued.state, .pending)
        try expectEqual(queued.requestID, "chat-request-1")
        try expectEqual(await store.pending().single()?.body, "오프라인 작성")
        try expect(gateway.syncReplayRequests.isEmpty, "chat sends must not use /sync replay")

        gateway.errorToThrow = nil
        gateway.nextSentMessage = generatedMessengerMessage(id: secondMessageID, body: "오프라인 작성", minute: 15)

        let summary = try await repository.replayPending()

        try expectEqual(summary, MessengerReplaySummary(attempted: 1, sent: 1, failed: 0))
        try expectEqual(await store.get(requestID: "chat-request-1")?.isSynced, true)
        try expectEqual(gateway.sentBodies, ["오프라인 작성", "오프라인 작성"])
        try expect(gateway.syncReplayRequests.isEmpty, "chat sends must not use /sync replay")
    }

    private static func keychainSessionStorePersistsTokensOutsideUserDefaults() async throws {
        let keychain = InMemoryKeychainAccess()
        let provider = CurrentTokenProvider()
        let store = KeychainSessionTokenStore(tokenProvider: provider, keychain: keychain)

        try expectEqual(await store.load(), nil)

        let tokens = AuthTokens(accessToken: "access.jwt", refreshToken: "refresh-token-30d")
        await store.save(tokens)

        try expectEqual(provider.get(), "access.jwt")
        try expectEqual(await store.load(), tokens)

        // The refresh token must live only in the Keychain blob, never as a plaintext value.
        let storedValues = keychain.allStoredStrings()
        try expect(
            storedValues.contains { $0.contains("refresh-token-30d") },
            "tokens should be persisted through the keychain"
        )

        await store.clear()
        try expectEqual(await store.load(), nil)
        try expectEqual(provider.get(), nil)
        try expect(keychain.isEmpty(), "clear should remove the keychain item")
    }

    private static func keychainSessionStoreMigratesLegacyGroupSessionForward() async throws {
        // A session written by a pre-shared-group build lives in the legacy
        // (default-group) store. After the update, load() must find it, migrate
        // it into the primary (shared-group) store, and remove the legacy copy —
        // so the user is NOT logged out on the shared-group switch.
        let primary = InMemoryKeychainAccess()
        let legacy = InMemoryKeychainAccess()
        let legacyTokens = AuthTokens(accessToken: "legacy.access", refreshToken: "legacy-refresh")
        legacy.write(try JSONEncoder().encode(legacyTokens), service: "maintenance.field", account: "maintenance.field.session")

        let provider = CurrentTokenProvider()
        let store = KeychainSessionTokenStore(
            tokenProvider: provider,
            keychain: primary,
            legacyKeychain: legacy
        )

        // init seeds the token provider from the legacy store (primary empty).
        try expectEqual(provider.get(), "legacy.access")

        // load() migrates: returns the tokens, writes them into primary, clears legacy.
        try expectEqual(await store.load(), legacyTokens)
        try expect(legacy.isEmpty(), "legacy session item should be removed after migration")
        try expect(
            primary.allStoredStrings().contains { $0.contains("legacy-refresh") },
            "migrated session should now live in the primary (shared-group) store"
        )

        // A subsequent load() reads straight from primary (legacy already empty).
        try expectEqual(await store.load(), legacyTokens)
        try expectEqual(provider.get(), "legacy.access")
    }

    private static func messengerRealtimeRequestUsesBearerHeaderAndResumeCursor() throws {
        let request = MessengerRealtimeRequestFactory(
            baseURL: URL(string: "https://api.example.com")!,
            accessToken: "access-token"
        ).build(lastMessageID: secondMessageID)

        try expectEqual(request.url.absoluteString, "wss://api.example.com/api/v1/ws?last_message_id=\(secondMessageID)")
        try expectEqual(request.headers["Authorization"], "Bearer access-token")
    }

    private static let workOrderID = "00000000-0000-0000-0000-000000000101"
    private static let stepUpCeremonyID = "00000000-0000-0000-0000-000000000904"
    private static let messengerThreadID = "22222222-2222-4222-8222-222222222222"
    private static let messengerBranchID = "11111111-1111-4111-8111-111111111111"
    private static let messengerSenderID = "33333333-3333-4333-8333-333333333333"
    private static let firstMessageID = "44444444-4444-4444-8444-444444444444"
    private static let secondMessageID = "55555555-5555-4555-8555-555555555555"
    fileprivate static let mailFolderID = "66666666-6666-4666-8666-666666666666"
    fileprivate static let mailThreadID = "77777777-7777-4777-8777-777777777777"
    fileprivate static let calendarEventID = "88888888-8888-4888-8888-888888888888"
    fileprivate static let pollID = "99999999-9999-4999-8999-999999999999"
    fileprivate static let pollOptionID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"

    private static func generatedWorkOrder(
        priority: Components.Schemas.PriorityLevel,
        status: Components.Schemas.WorkOrderStatus
    ) -> Components.Schemas.WorkOrderListItem {
        Components.Schemas.WorkOrderListItem(
            id: "00000000-0000-0000-0000-000000000111",
            requestNo: "20260612-001",
            branchId: "00000000-0000-0000-0000-000000000222",
            status: status,
            priority: priority,
            resultType: .unknown,
            targetDueAt: isoDate("2026-06-12T13:00:00Z"),
            createdAt: isoDate("2026-06-12T08:00:00Z"),
            updatedAt: isoDate("2026-06-12T08:05:00Z"),
            equipment: Components.Schemas.EquipmentSummary(
                id: "00000000-0000-0000-0000-000000000333",
                equipmentNo: "D290",
                managementNo: "290",
                model: "GTS25DE",
                status: "임대",
                specification: "좌식",
                tonText: "2.5t"
            ),
            customer: Components.Schemas.NamedEntity(
                id: "00000000-0000-0000-0000-000000000444",
                name: "대성물류"
            ),
            site: Components.Schemas.NamedEntity(
                id: "00000000-0000-0000-0000-000000000555",
                name: "1공장"
            ),
            assignments: [
                Components.Schemas.AssignmentSummary(
                    id: "00000000-0000-0000-0000-000000000666",
                    mechanicId: "00000000-0000-0000-0000-000000000777",
                    mechanicName: "김정비",
                    role: .primary,
                    assignedAt: isoDate("2026-06-12T08:10:00Z")
                ),
            ]
        )
    }

    private static func summary(status: Components.Schemas.WorkOrderStatus) -> Components.Schemas.WorkOrderSummary {
        Components.Schemas.WorkOrderSummary(
            id: workOrderID,
            requestNo: "20260612-001",
            branchId: "00000000-0000-0000-0000-000000000201",
            equipmentId: "00000000-0000-0000-0000-000000000301",
            customerId: "00000000-0000-0000-0000-000000000401",
            siteId: "00000000-0000-0000-0000-000000000501",
            status: status,
            priority: .p1,
            resultType: .unknown,
            evidenceVerified: false
        )
    }

    private static func generatedMessengerThread() -> Components.Schemas.MessengerThreadSummary {
        Components.Schemas.MessengerThreadSummary(
            id: messengerThreadID,
            kind: .team,
            branchId: messengerBranchID,
            title: "팀 채널",
            memberCount: 3,
            unreadCount: 0,
            createdAt: isoDate("2026-06-12T09:00:00Z"),
            updatedAt: isoDate("2026-06-12T09:00:00Z")
        )
    }

    private static func generatedMessengerMessage(
        id: Components.Schemas.Uuid,
        body: String,
        minute: Int
    ) -> Components.Schemas.MessengerMessageSummary {
        Components.Schemas.MessengerMessageSummary(
            id: id,
            threadId: messengerThreadID,
            branchId: messengerBranchID,
            senderId: messengerSenderID,
            body: body,
            attachmentEvidenceIds: [],
            readCount: 1,
            readTargetCount: 2,
            sentAt: isoDate("2026-06-12T09:\(String(format: "%02d", minute)):00Z"),
            createdAt: isoDate("2026-06-12T09:\(String(format: "%02d", minute)):00Z")
        )
    }



    fileprivate static func emptyApprovalItemsPage() -> Components.Schemas.ApprovalItemsPage {
        Components.Schemas.ApprovalItemsPage(items: [], sources: [], limit: 50, offset: 0, total: 0)
    }

    fileprivate static func generatedWorkOrderApprovalItemsPage() -> Components.Schemas.ApprovalItemsPage {
        let branchID: Components.Schemas.Uuid = "00000000-0000-0000-0000-000000000222"
        let tenantID: Components.Schemas.Uuid = "00000000-0000-0000-0000-000000000999"
        let item = Components.Schemas.ApprovalItem(
            id: "WORK_ORDER:\(workOrderID)",
            source: .workOrder,
            sourceId: workOrderID,
            branchId: branchID,
            status: "ADMIN_REVIEW",
            title: "작업 보고 승인",
            summary: "정비 보고를 승인합니다.",
            requestedAt: isoDate("2026-06-12T12:00:00Z"),
            dueAt: nil,
            href: "/work-orders/\(workOrderID)",
            actionHref: "/api/work-orders/\(workOrderID)/approve",
            ontology: Components.Schemas.ApprovalOntologyContext(
                objectType: .workOrder,
                objectId: workOrderID,
                tenantId: tenantID,
                branchId: branchID
            ),
            workflow: Components.Schemas.ApprovalWorkflowContext(
                workflowKey: "work_order.report",
                actionKey: "approve"
            ),
            policy: Components.Schemas.ApprovalPolicyContext(
                decision: .allowed,
                enforcement: .server,
                requiredFeatures: ["ApprovalDecide"],
                scopeKind: .branch,
                scopeId: branchID
            ),
            workOrder: generatedWorkOrder(priority: .p2, status: .adminReview)
        )
        return Components.Schemas.ApprovalItemsPage(items: [item], sources: [], limit: 50, offset: 0, total: 1)
    }

    fileprivate static func generatedMailFolder() -> Components.Schemas.MailFolderView {
        Components.Schemas.MailFolderView(
            id: mailFolderID,
            role: "INBOX",
            name: "받은메일함",
            unreadCount: 2,
            totalCount: 10
        )
    }

    fileprivate static func generatedMailThread(unreadCount: Int64 = 2) -> Components.Schemas.MailThreadView {
        Components.Schemas.MailThreadView(
            id: mailThreadID,
            subject: "승인 증빙 확인",
            lastMessageAt: isoDate("2026-06-12T11:30:00Z"),
            messageCount: 4,
            unreadCount: unreadCount,
            hasAttachments: true,
            isFlagged: false
        )
    }

    fileprivate static func generatedCollaborationPolicy() -> Components.Schemas.CollaborationScopePolicy {
        Components.Schemas.CollaborationScopePolicy(
            enforcement: .server,
            scopeType: .org,
            visibility: .orgMembers
        )
    }

    fileprivate static func generatedCalendarEvent() -> Components.Schemas.CalendarEventResponse {
        Components.Schemas.CalendarEventResponse(
            id: calendarEventID,
            scopeType: .org,
            title: "주간 정비 계획",
            description: "현장 정비 캘린더",
            startsAt: isoDate("2026-06-12T13:00:00Z"),
            endsAt: isoDate("2026-06-12T14:00:00Z"),
            allDay: false,
            status: .active,
            objectType: "work_order",
            createdAt: isoDate("2026-06-12T10:00:00Z"),
            updatedAt: isoDate("2026-06-12T10:00:00Z"),
            policy: generatedCollaborationPolicy()
        )
    }

    fileprivate static func generatedPoll(submitted: Bool, voteCount: Int64) -> Components.Schemas.PollResponse {
        Components.Schemas.PollResponse(
            id: pollID,
            targetScopeType: .org,
            title: "작업 일정 투표",
            question: "오전 정비를 먼저 진행할까요?",
            status: .open,
            anonymity: .named,
            allowMultiple: false,
            objectType: "work_order",
            options: [
                Components.Schemas.PollOptionResponse(
                    id: pollOptionID,
                    label: "찬성",
                    position: 0,
                    voteCount: voteCount
                ),
            ],
            voteCount: voteCount,
            myVote: Components.Schemas.PollMyVote(
                submitted: submitted,
                selectedOptionIds: submitted ? [pollOptionID] : []
            ),
            createdAt: isoDate("2026-06-12T10:00:00Z"),
            updatedAt: isoDate("2026-06-12T10:00:00Z"),
            policy: generatedCollaborationPolicy()
        )
    }

    fileprivate static func generatedDevice(pushToken: String?) -> Components.Schemas.DeviceRegistrationResponse {
        Components.Schemas.DeviceRegistrationResponse(
            id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            userId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
            deviceHash: "hash",
            platform: .ios,
            pushToken: pushToken,
            appVersion: "0.1.0",
            lastRegisteredAt: isoDate("2026-06-12T12:00:00Z")
        )
    }

    fileprivate static func generatedPasskeyChallenge() -> Components.Schemas.PasskeyLoginStartResponse {
        Components.Schemas.PasskeyLoginStartResponse(
            ceremonyId: "00000000-0000-0000-0000-000000000902",
            challenge: Components.Schemas.PasskeyLoginStartResponse.ChallengePayload(),
            expiresAt: isoDate("2026-06-12T09:05:00Z")
        )
    }

    fileprivate static func generatedMobileStepUpStart(
        binding: Components.Schemas.MobilePasskeyStepUpBinding
    ) throws -> Components.Schemas.MobilePasskeyStepUpStartResponse {
        let challenge = try JSONDecoder().decode(
            Components.Schemas.MobilePasskeyStepUpStartResponse.ChallengePayload.self,
            from: Data(#"{"publicKey":{"challenge":"_-7dAH8","allowCredentials":[]}}"#.utf8)
        )
        return Components.Schemas.MobilePasskeyStepUpStartResponse(
            ceremonyId: stepUpCeremonyID,
            challenge: challenge,
            expiresAt: isoDate("2026-06-12T09:06:00Z"),
            binding: binding
        )
    }

    fileprivate static func mobileStepUpBinding(
        actionKind: Components.Schemas.MobileStepUpActionKind,
        objectID: Components.Schemas.Uuid,
        reasonKey: Components.Schemas.MobilePasskeyStepUpBinding.ReasonKeyPayload,
        replayAttempt: Int32?
    ) -> Components.Schemas.MobilePasskeyStepUpBinding {
        Components.Schemas.MobilePasskeyStepUpBinding(
            actionKind: actionKind,
            objectId: objectID,
            reasonKey: reasonKey,
            replayAttempt: replayAttempt
        )
    }

    fileprivate static func generatedMobileStepUpEnvelope(
        actionKind: Components.Schemas.MobileStepUpActionKind,
        objectID: Components.Schemas.Uuid,
        reasonKey: Components.Schemas.MobilePasskeyStepUpBinding.ReasonKeyPayload,
        replayAttempt: Int32?,
        ceremonyID: Components.Schemas.Uuid
    ) -> Components.Schemas.MobilePasskeyStepUpEnvelope {
        generatedMobileStepUpEnvelope(
            binding: mobileStepUpBinding(
                actionKind: actionKind,
                objectID: objectID,
                reasonKey: reasonKey,
                replayAttempt: replayAttempt
            ),
            ceremonyID: ceremonyID
        )
    }

    fileprivate static func generatedMobileStepUpEnvelope(
        binding: Components.Schemas.MobilePasskeyStepUpBinding,
        ceremonyID: Components.Schemas.Uuid
    ) -> Components.Schemas.MobilePasskeyStepUpEnvelope {
        Components.Schemas.MobilePasskeyStepUpEnvelope(
            binding: binding,
            assertion: Components.Schemas.PasskeyStepUpAssertion(
                ceremonyId: ceremonyID,
                credential: Components.Schemas.PasskeyStepUpAssertion.CredentialPayload()
            )
        )
    }

    fileprivate static func generatedTokenPair(refreshToken: String?) -> Components.Schemas.TokenPairResponse {
        Components.Schemas.TokenPairResponse(
            accessToken: "access.jwt",
            refreshToken: refreshToken,
            tokenType: .bearer,
            refreshExpiresAt: isoDate("2026-07-12T09:05:00Z"),
            requiresPasskeySetup: false
        )
    }

    private static func isoDate(_ value: String) -> Date {
        ISO8601DateFormatter().date(from: value)!
    }

    private static func temporaryMobileOperationsStoreRoot() throws -> URL {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("mobile-operations-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        return root
    }

    private static func temporaryEvidenceStoreRoot() throws -> URL {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("evidence-upload-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        return root
    }

    private static func temporaryOfflineQueueStoreURL() throws -> URL {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("offline-queue-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        return root.appendingPathComponent("offline-queue.sqlite")
    }

    private static func evidenceUploadURLSession() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [EvidenceUploadURLProtocol.self]
        return URLSession(configuration: configuration)
    }

    private static func reportDraft() -> ReportDraft {
        ReportDraft(
            resultType: .completed,
            diagnosis: "  배터리 단선  ",
            actionTaken: "  케이블 교체  "
        )
    }

    private static func workOrderRepositoryFixture(
        gateway: RecordingEvidenceMaintenanceGateway,
        requestIDs: [String]
    ) -> (repository: WorkOrderRepository, store: InMemoryMutationQueueStore) {
        let store = InMemoryMutationQueueStore()
        let offlineQueue = OfflineQueueRepository(
            store: store,
            syncGateway: RecordingSyncGateway(),
            deviceIDProvider: { "device-a" },
            requestIDFactory: SequenceRequestIDFactory(requestIDs),
            syncIDFactory: FixedRequestIDFactory("sync-work-order"),
            clock: FixedClock(date: isoDate("2026-06-12T14:00:00Z"))
        )
        let repository = WorkOrderRepository(
            gateway: gateway,
            cache: WorkOrderCacheStore(),
            offlineQueue: offlineQueue
        )
        return (repository, store)
    }

    private static func expectAsyncThrows<T>(
        file: StaticString = #fileID,
        line: UInt = #line,
        operation: () async throws -> T
    ) async throws -> Error {
        do {
            _ = try await operation()
        } catch {
            return error
        }
        throw BehaviorTestFailure("\(file):\(line) expected async operation to throw")
    }

    private static func expect(_ condition: @autoclosure () -> Bool, _ message: String) throws {
        guard condition() else {
            throw BehaviorTestFailure(message)
        }
    }

    private static func expectEqual<T: Equatable>(
        _ actual: T,
        _ expected: T,
        file: StaticString = #fileID,
        line: UInt = #line
    ) throws {
        guard actual == expected else {
            throw BehaviorTestFailure("\(file):\(line) expected \(expected), got \(actual)")
        }
    }

    private static func expectThrows<T, E: Error & Equatable>(
        _ expected: E,
        redactedFragments: [String] = [],
        file: StaticString = #fileID,
        line: UInt = #line,
        operation: () throws -> T
    ) throws {
        do {
            _ = try operation()
            throw BehaviorTestFailure("\(file):\(line) expected error \(expected)")
        } catch let error as E {
            try expectEqual(error, expected, file: file, line: line)
            let descriptions = [String(describing: error), (error as NSError).localizedDescription]
            for fragment in redactedFragments {
                for description in descriptions {
                    try expect(
                        !description.contains(fragment),
                        "\(file):\(line) error description leaked sensitive passkey material"
                    )
                }
            }
        } catch {
            throw BehaviorTestFailure("\(file):\(line) expected error \(expected), got \(error)")
        }
    }

    private enum ExpectedPersistenceFailure: CustomStringConvertible {
        case corruptJSON(String)
        case writeFailed(String)
        case fetchFailed(String)
        case saveFailed(String)

        var description: String {
            switch self {
            case let .corruptJSON(store):
                return "corruptJSON(\(store))"
            case let .writeFailed(store):
                return "writeFailed(\(store))"
            case let .fetchFailed(store):
                return "fetchFailed(\(store))"
            case let .saveFailed(store):
                return "saveFailed(\(store))"
            }
        }
    }

    private static func expectPersistenceFailure<T>(
        _ expected: ExpectedPersistenceFailure,
        file: StaticString = #fileID,
        line: UInt = #line,
        operation: () throws -> T
    ) throws {
        do {
            _ = try operation()
            throw BehaviorTestFailure("\(file):\(line) expected persistence error \(expected)")
        } catch let error as PersistenceStoreError {
            try expect(
                persistenceFailure(error, matches: expected),
                "\(file):\(line) expected persistence error \(expected), got \(error)"
            )
        } catch {
            throw BehaviorTestFailure("\(file):\(line) expected persistence error \(expected), got \(error)")
        }
    }

    private static func expectPersistenceFailureAsync<T>(
        _ expected: ExpectedPersistenceFailure,
        file: StaticString = #fileID,
        line: UInt = #line,
        operation: () async throws -> T
    ) async throws {
        do {
            _ = try await operation()
            throw BehaviorTestFailure("\(file):\(line) expected persistence error \(expected)")
        } catch let error as PersistenceStoreError {
            try expect(
                persistenceFailure(error, matches: expected),
                "\(file):\(line) expected persistence error \(expected), got \(error)"
            )
        } catch {
            throw BehaviorTestFailure("\(file):\(line) expected persistence error \(expected), got \(error)")
        }
    }

    private static func persistenceFailure(
        _ error: PersistenceStoreError,
        matches expected: ExpectedPersistenceFailure
    ) -> Bool {
        switch (error, expected) {
        case let (.corruptJSON(store, _), .corruptJSON(expectedStore)):
            return store == expectedStore
        case let (.writeFailed(store, _), .writeFailed(expectedStore)):
            return store == expectedStore
        case let (.fetchFailed(store, _), .fetchFailed(expectedStore)):
            return store == expectedStore
        case let (.saveFailed(store, _), .saveFailed(expectedStore)):
            return store == expectedStore
        default:
            return false
        }
    }

    fileprivate static func expectNotNil<T>(_ value: T?) throws -> T {
        guard let value else {
            throw BehaviorTestFailure("expected non-nil value")
        }
        return value
    }
}



private final class RecordingMobileOperationsGateway: MobileOperationsGateway, @unchecked Sendable {
    var errorToThrow: Error?
    var approvalPage = MaintenanceFieldCoreBehaviorTests.emptyApprovalItemsPage()
    var mailFolders = [MaintenanceFieldCoreBehaviorTests.generatedMailFolder()]
    var mailThreads = [MaintenanceFieldCoreBehaviorTests.generatedMailThread()]
    var calendarEvents = [MaintenanceFieldCoreBehaviorTests.generatedCalendarEvent()]
    var polls = [MaintenanceFieldCoreBehaviorTests.generatedPoll(submitted: false, voteCount: 0)]
    private(set) var approvalQueries: [(limit: Int64, offset: Int64)] = []
    private(set) var readStateRequests: [(threadID: Components.Schemas.Uuid, seen: Bool)] = []
    private(set) var pollVoteRequests: [(pollID: Components.Schemas.Uuid, selectedOptionIDs: [Components.Schemas.Uuid], stepUp: Components.Schemas.MobilePasskeyStepUpEnvelope)] = []
    private(set) var deviceRegistrations: [(deviceID: String, appVersion: String, pushToken: String?)] = []
    private(set) var approvedWorkOrders: [(workOrderID: Components.Schemas.Uuid, comment: String, stepUp: Components.Schemas.MobilePasskeyStepUpEnvelope)] = []
    private(set) var locationPings: [Components.Schemas.LocationPingRequest] = []

    func listApprovalItems(limit: Int64, offset: Int64) async throws -> Components.Schemas.ApprovalItemsPage {
        approvalQueries.append((limit, offset))
        if let errorToThrow {
            self.errorToThrow = nil
            throw errorToThrow
        }
        return approvalPage
    }

    func approveWorkOrder(
        workOrderID: Components.Schemas.Uuid,
        comment: String,
        stepUp: Components.Schemas.MobilePasskeyStepUpEnvelope
    ) async throws {
        if let errorToThrow {
            self.errorToThrow = nil
            throw errorToThrow
        }
        approvedWorkOrders.append((workOrderID, comment, stepUp))
    }

    func listMailFolders() async throws -> [Components.Schemas.MailFolderView] {
        mailFolders
    }

    func listMailThreads(
        unread: Bool?,
        query: String?,
        folderID: Components.Schemas.Uuid?,
        before: Int64?,
        limit: Int64
    ) async throws -> [Components.Schemas.MailThreadView] {
        mailThreads
    }

    func setMailThreadReadState(threadID: Components.Schemas.Uuid, seen: Bool) async throws {
        readStateRequests.append((threadID, seen))
    }

    func listCalendarEvents(
        from: Components.Schemas.Timestamp?,
        to: Components.Schemas.Timestamp?,
        limit: Int64
    ) async throws -> [Components.Schemas.CalendarEventResponse] {
        calendarEvents
    }

    func listPolls(status: Components.Schemas.PollStatus?, limit: Int64) async throws -> [Components.Schemas.PollResponse] {
        polls
    }

    func votePoll(
        pollID: Components.Schemas.Uuid,
        selectedOptionIDs: [Components.Schemas.Uuid],
        stepUp: Components.Schemas.MobilePasskeyStepUpEnvelope
    ) async throws -> Components.Schemas.PollResponse {
        pollVoteRequests.append((pollID, selectedOptionIDs, stepUp))
        let updated = MaintenanceFieldCoreBehaviorTests.generatedPoll(submitted: true, voteCount: Int64(selectedOptionIDs.count))
        polls = [updated]
        return updated
    }

    func registerDevice(
        deviceID: String,
        appVersion: String,
        pushToken: String?
    ) async throws -> Components.Schemas.DeviceRegistrationResponse {
        if let errorToThrow {
            self.errorToThrow = nil
            throw errorToThrow
        }
        deviceRegistrations.append((deviceID, appVersion, pushToken))
        return MaintenanceFieldCoreBehaviorTests.generatedDevice(pushToken: pushToken)
    }

    func recordLocationPing(_ request: Components.Schemas.LocationPingRequest) async throws {
        if let errorToThrow {
            self.errorToThrow = nil
            throw errorToThrow
        }
        locationPings.append(request)
    }
}

private actor InMemoryEvidenceUploadStore: EvidenceUploadStore {
    private var uploads: [String: PendingEvidenceUpload] = [:]

    func upsert(_ upload: PendingEvidenceUpload) {
        uploads[upload.id] = upload
    }

    func pending() -> [PendingEvidenceUpload] {
        uploads.values
            .filter { $0.syncState == .pending }
            .sorted { $0.id < $1.id }
    }

    func get(id: String) -> PendingEvidenceUpload? {
        uploads[id]
    }

    func markSynced(id: String) {
        uploads[id]?.syncState = .synced
        uploads[id]?.lastError = nil
        uploads[id]?.retryAttemptCount = 0
        uploads[id]?.nextRetryAt = nil
    }

    func markRetrying(id: String, message: String, retryAttemptCount: Int, nextRetryAt: Date) {
        uploads[id]?.syncState = .pending
        uploads[id]?.lastError = message
        uploads[id]?.retryAttemptCount = retryAttemptCount
        uploads[id]?.nextRetryAt = nextRetryAt
    }

    func markFailed(id: String, message: String) {
        uploads[id]?.syncState = .failed
        uploads[id]?.lastError = message
        uploads[id]?.nextRetryAt = nil
    }
}

private final class RecordingEvidenceMaintenanceGateway: MaintenanceAPIGateway, @unchecked Sendable {
    var errorToThrow: Error?
    var startError: Error?
    var reportError: Error?
    var detailError: Error?
    var detailWorkOrder: TechnicianWorkOrder?
    var uploadHeaders: [OpenAPIArrayContainer] = []
    private(set) var presignRequests: [Components.Schemas.EvidencePresignRequest] = []
    private(set) var startedWorkOrderIDs: [Components.Schemas.Uuid] = []
    private(set) var submittedReportIDs: [Components.Schemas.Uuid] = []

    func presignEvidence(_ request: Components.Schemas.EvidencePresignRequest) async throws -> Components.Schemas.EvidencePresignResponse {
        presignRequests.append(request)
        if let errorToThrow {
            self.errorToThrow = nil
            throw errorToThrow
        }
        return Components.Schemas.EvidencePresignResponse(
            id: "00000000-0000-0000-0000-000000000991",
            workOrderId: request.workOrderId,
            stage: request.stage,
            upload: Components.Schemas.PresignedUpload(
                method: .put,
                url: "https://uploads.example/evidence",
                headers: uploadHeaders,
                expiresInSecs: 60
            )
        )
    }

    func confirmEvidence(evidenceID: Components.Schemas.Uuid) async throws -> Components.Schemas.EvidenceConfirmResponse {
        if let errorToThrow {
            self.errorToThrow = nil
            throw errorToThrow
        }
        return Components.Schemas.EvidenceConfirmResponse(
            id: evidenceID,
            workOrderId: "00000000-0000-0000-0000-000000000101",
            stage: .after,
            wormReplicaStatus: .verified,
            retryCount: 0,
            verifiedAt: nil
        )
    }

    func listTodayWorkOrders() async throws -> [TechnicianWorkOrder] { throw BehaviorTestFailure("unused evidence test gateway") }
    func getWorkOrderDetail(id: Components.Schemas.Uuid) async throws -> TechnicianWorkOrder {
        if let detailError {
            throw detailError
        }
        return try MaintenanceFieldCoreBehaviorTests.expectNotNil(detailWorkOrder)
    }
    func startWorkOrder(id: Components.Schemas.Uuid) async throws {
        startedWorkOrderIDs.append(id)
        if let startError {
            throw startError
        }
    }
    func submitReport(id: Components.Schemas.Uuid, draft: ReportDraft) async throws {
        submittedReportIDs.append(id)
        if let reportError {
            throw reportError
        }
    }
    func startPasskeyLogin() async throws -> Components.Schemas.PasskeyLoginStartResponse { throw BehaviorTestFailure("unused evidence test gateway") }
    func finishPasskeyLogin(ceremonyID: Components.Schemas.Uuid, credential: Components.Schemas.PasskeyLoginFinishRequest.CredentialPayload) async throws -> Components.Schemas.TokenPairResponse { throw BehaviorTestFailure("unused evidence test gateway") }
    func registerDevice(deviceID: String, appVersion: String) async throws -> Components.Schemas.DeviceRegistrationResponse { throw BehaviorTestFailure("unused evidence test gateway") }
    func getLocationConsentStatus() async throws -> Components.Schemas.LocationConsentStatus { throw BehaviorTestFailure("unused evidence test gateway") }
    func grantLocationConsent() async throws -> Components.Schemas.LocationConsentStatus { throw BehaviorTestFailure("unused evidence test gateway") }
    func suspendLocationConsent() async throws -> Components.Schemas.LocationConsentStatus { throw BehaviorTestFailure("unused evidence test gateway") }
    func resumeLocationConsent() async throws -> Components.Schemas.LocationConsentStatus { throw BehaviorTestFailure("unused evidence test gateway") }
    func withdrawLocationConsent() async throws -> Components.Schemas.LocationConsentStatus { throw BehaviorTestFailure("unused evidence test gateway") }
    func recordLocationPing(_ request: Components.Schemas.LocationPingRequest) async throws { throw BehaviorTestFailure("unused evidence test gateway") }
    func replay(deviceID: String, request: Components.Schemas.SyncBatchRequest) async throws -> Components.Schemas.SyncBatchResponse { throw BehaviorTestFailure("unused evidence test gateway") }
    func listApprovalItems(limit: Int64, offset: Int64) async throws -> Components.Schemas.ApprovalItemsPage { throw BehaviorTestFailure("unused evidence test gateway") }
    func startMobilePasskeyStepUp(binding: Components.Schemas.MobilePasskeyStepUpBinding) async throws -> Components.Schemas.MobilePasskeyStepUpStartResponse { throw BehaviorTestFailure("unused evidence test gateway") }
    func approveWorkOrder(workOrderID: Components.Schemas.Uuid, comment: String, stepUp: Components.Schemas.MobilePasskeyStepUpEnvelope) async throws { throw BehaviorTestFailure("unused evidence test gateway") }
    func listMailFolders() async throws -> [Components.Schemas.MailFolderView] { throw BehaviorTestFailure("unused evidence test gateway") }
    func listMailThreads(unread: Bool?, query: String?, folderID: Components.Schemas.Uuid?, before: Int64?, limit: Int64) async throws -> [Components.Schemas.MailThreadView] { throw BehaviorTestFailure("unused evidence test gateway") }
    func setMailThreadReadState(threadID: Components.Schemas.Uuid, seen: Bool) async throws { throw BehaviorTestFailure("unused evidence test gateway") }
    func listCalendarEvents(from: Components.Schemas.Timestamp?, to: Components.Schemas.Timestamp?, limit: Int64) async throws -> [Components.Schemas.CalendarEventResponse] { throw BehaviorTestFailure("unused evidence test gateway") }
    func listPolls(status: Components.Schemas.PollStatus?, limit: Int64) async throws -> [Components.Schemas.PollResponse] { throw BehaviorTestFailure("unused evidence test gateway") }
    func votePoll(pollID: Components.Schemas.Uuid, selectedOptionIDs: [Components.Schemas.Uuid], stepUp: Components.Schemas.MobilePasskeyStepUpEnvelope) async throws -> Components.Schemas.PollResponse { throw BehaviorTestFailure("unused evidence test gateway") }
    func registerDevice(deviceID: String, appVersion: String, pushToken: String?) async throws -> Components.Schemas.DeviceRegistrationResponse { throw BehaviorTestFailure("unused evidence test gateway") }
    func listThreads(limit: Int64) async throws -> [MessengerThread] { throw BehaviorTestFailure("unused evidence test gateway") }
    func listMessages(threadID: Components.Schemas.Uuid, beforeMessageID: Components.Schemas.Uuid?, limit: Int64) async throws -> MessengerMessagePage { throw BehaviorTestFailure("unused evidence test gateway") }
    func sendMessage(threadID: Components.Schemas.Uuid, body: String, attachmentEvidenceIDs: [Components.Schemas.Uuid]) async throws -> MessengerMessage { throw BehaviorTestFailure("unused evidence test gateway") }
    func markRead(threadID: Components.Schemas.Uuid, lastReadMessageID: Components.Schemas.Uuid) async throws { throw BehaviorTestFailure("unused evidence test gateway") }
    func search(query: String, limit: Int64) async throws -> [MessengerMessage] { throw BehaviorTestFailure("unused evidence test gateway") }
}

private final class EvidenceUploadURLProtocolState: @unchecked Sendable {
    private let lock = NSLock()
    private var statusCodes: [Int] = []
    private var requests: [URLRequest] = []

    func setStatusCodes(_ statusCodes: [Int]) {
        lock.lock()
        self.statusCodes = statusCodes
        self.requests = []
        lock.unlock()
    }

    func record(_ request: URLRequest) {
        lock.lock()
        requests.append(request)
        lock.unlock()
    }

    func recordedRequests() -> [URLRequest] {
        lock.lock()
        defer { lock.unlock() }
        return requests
    }

    func nextStatusCode() -> Int {
        lock.lock()
        defer { lock.unlock() }
        if statusCodes.isEmpty {
            return 200
        }
        return statusCodes.removeFirst()
    }
}

private final class EvidenceUploadURLProtocol: URLProtocol, @unchecked Sendable {
    private static let state = EvidenceUploadURLProtocolState()

    static func setStatusCodes(_ statusCodes: [Int]) {
        state.setStatusCodes(statusCodes)
    }

    static func recordedRequests() -> [URLRequest] {
        state.recordedRequests()
    }

    override class func canInit(with request: URLRequest) -> Bool {
        request.url?.host == "uploads.example"
    }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest {
        request
    }

    override func startLoading() {
        Self.state.record(request)
        guard let url = request.url,
              let response = HTTPURLResponse(
                url: url,
                statusCode: Self.state.nextStatusCode(),
                httpVersion: "HTTP/1.1",
                headerFields: nil
              ) else {
            client?.urlProtocol(self, didFailWithError: URLError(.badURL))
            return
        }
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data())
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

private final class RecordingSyncGateway: SyncGateway, @unchecked Sendable {
    var nextResponse = Components.Schemas.SyncBatchResponse(syncId: "sync", results: [])
    var errorToThrow: Error?
    private(set) var requests: [Components.Schemas.SyncBatchRequest] = []
    private(set) var deviceIDs: [String] = []

    func replay(
        deviceID: String,
        request: Components.Schemas.SyncBatchRequest
    ) async throws -> Components.Schemas.SyncBatchResponse {
        if let errorToThrow {
            throw errorToThrow
        }
        deviceIDs.append(deviceID)
        requests.append(request)
        return nextResponse
    }
}

private final class RecordingMessengerGateway: MessengerGateway, @unchecked Sendable {
    var nextSentMessage: Components.Schemas.MessengerMessageSummary?
    var errorToThrow: Error?
    private(set) var sentBodies: [String] = []
    private(set) var syncReplayRequests: [String] = []

    func listThreads(limit: Int64) async throws -> [MessengerThread] {
        []
    }

    func listMessages(
        threadID: Components.Schemas.Uuid,
        beforeMessageID: Components.Schemas.Uuid?,
        limit: Int64
    ) async throws -> MessengerMessagePage {
        MessengerMessagePage(items: [], nextCursor: nil)
    }

    func sendMessage(
        threadID: Components.Schemas.Uuid,
        body: String,
        attachmentEvidenceIDs: [Components.Schemas.Uuid]
    ) async throws -> MessengerMessage {
        sentBodies.append(body)
        if let errorToThrow {
            self.errorToThrow = nil
            throw errorToThrow
        }
        return try MaintenanceFieldCoreBehaviorTests.expectNotNil(nextSentMessage).toMessengerMessage()
    }

    func markRead(threadID: Components.Schemas.Uuid, lastReadMessageID: Components.Schemas.Uuid) async throws {}

    func search(query: String, limit: Int64) async throws -> [MessengerMessage] {
        []
    }
}

private final class InMemoryKeychainAccess: KeychainAccess, @unchecked Sendable {
    private let lock = NSLock()
    private var storage: [String: Data] = [:]

    func read(service: String, account: String) -> Data? {
        lock.lock()
        defer { lock.unlock() }
        return storage["\(service).\(account)"]
    }

    func write(_ data: Data, service: String, account: String) {
        lock.lock()
        storage["\(service).\(account)"] = data
        lock.unlock()
    }

    func delete(service: String, account: String) {
        lock.lock()
        storage["\(service).\(account)"] = nil
        lock.unlock()
    }

    func allStoredStrings() -> [String] {
        lock.lock()
        defer { lock.unlock() }
        return storage.values.compactMap { String(data: $0, encoding: .utf8) }
    }

    func isEmpty() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return storage.isEmpty
    }
}

private final class RecordingPasskeyAuthGateway: PasskeyAuthGateway, @unchecked Sendable {
    let challenge: Components.Schemas.PasskeyLoginStartResponse
    var tokens: Components.Schemas.TokenPairResponse
    let registeredDevice: Components.Schemas.DeviceRegistrationResponse
    var startError: Error?
    var finishError: Error?
    var registrationError: Error?
    private(set) var registrationAttempts: [String] = []

    init(
        challenge: Components.Schemas.PasskeyLoginStartResponse,
        tokens: Components.Schemas.TokenPairResponse,
        registeredDevice: Components.Schemas.DeviceRegistrationResponse
    ) {
        self.challenge = challenge
        self.tokens = tokens
        self.registeredDevice = registeredDevice
    }

    func startPasskeyLogin() async throws -> Components.Schemas.PasskeyLoginStartResponse {
        if let startError {
            throw startError
        }
        return challenge
    }

    func finishPasskeyLogin(
        ceremonyID: Components.Schemas.Uuid,
        credential: Components.Schemas.PasskeyLoginFinishRequest.CredentialPayload
    ) async throws -> Components.Schemas.TokenPairResponse {
        if let finishError {
            throw finishError
        }
        return tokens
    }

    func registerDevice(deviceID: String, appVersion: String) async throws -> Components.Schemas.DeviceRegistrationResponse {
        registrationAttempts.append("\(deviceID)@\(appVersion)")
        if let registrationError {
            throw registrationError
        }
        return registeredDevice
    }
}

private final class RecordingPasskeyStepUpGateway: PasskeyStepUpGateway, @unchecked Sendable {
    var response: Components.Schemas.MobilePasskeyStepUpStartResponse
    private(set) var startBindings: [Components.Schemas.MobilePasskeyStepUpBinding] = []

    init(response: Components.Schemas.MobilePasskeyStepUpStartResponse) {
        self.response = response
    }

    func startMobilePasskeyStepUp(
        binding: Components.Schemas.MobilePasskeyStepUpBinding
    ) async throws -> Components.Schemas.MobilePasskeyStepUpStartResponse {
        startBindings.append(binding)
        return response
    }
}

private struct StaticPasskeyCredentialProvider: PasskeyCredentialProvider {
    @MainActor
    func credentialAssertion(
        challengeJSON: String
    ) async throws -> Components.Schemas.PasskeyLoginFinishRequest.CredentialPayload {
        Components.Schemas.PasskeyLoginFinishRequest.CredentialPayload()
    }
}

private actor InMemorySessionTokenStore: SessionTokenStore {
    private var tokens: AuthTokens?
    private var clears = 0

    init(tokens: AuthTokens? = nil) {
        self.tokens = tokens
    }

    func load() -> AuthTokens? {
        tokens
    }

    func save(_ tokens: AuthTokens) {
        self.tokens = tokens
    }

    func clear() {
        tokens = nil
        clears += 1
    }

    func clearCalls() -> Int {
        clears
    }
}

private struct FixedDeviceIDStore: DeviceIDStore {
    let deviceID: String

    func loadOrCreate() -> String {
        deviceID
    }
}

private struct FixedRequestIDFactory: RequestIDFactory {
    let value: String

    init(_ value: String) {
        self.value = value
    }

    func nextID() -> String {
        value
    }
}

private final class SequenceRequestIDFactory: RequestIDFactory, @unchecked Sendable {
    private let lock = NSLock()
    private var values: [String]

    init(_ values: [String]) {
        self.values = values
    }

    func nextID() -> String {
        lock.lock()
        defer { lock.unlock() }
        if values.isEmpty {
            return UUID().uuidString.lowercased()
        }
        return values.removeFirst()
    }
}

private struct FixedMessengerRequestIDFactory: MessengerRequestIDFactory {
    let value: String

    init(_ value: String) {
        self.value = value
    }

    func nextID() -> String {
        value
    }
}

private struct FixedClock: FieldClock {
    let date: Date

    func now() -> Date {
        date
    }
}

private final class MutableClock: FieldClock, @unchecked Sendable {
    var date: Date

    init(date: Date) {
        self.date = date
    }

    func now() -> Date {
        date
    }
}

private struct BehaviorTestFailure: Error, CustomStringConvertible {
    let description: String

    init(_ description: String) {
        self.description = description
    }
}

private extension Array {
    func single() -> Element? {
        count == 1 ? self[0] : nil
    }
}
