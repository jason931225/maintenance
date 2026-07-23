import SwiftUI

#if os(iOS)
import AVFoundation
import Foundation
import UIKit

struct CameraCaptureView: View {
    let onCapture: (URL) -> Void
    let onCancel: () -> Void
    let onError: () -> Void

    @Environment(\.scenePhase) private var scenePhase
    @State private var authorizationStatus = AVCaptureDevice.authorizationStatus(for: .video)

    var body: some View {
        Group {
            switch authorizationStatus {
            case .authorized:
                if hasBackCamera {
                    CameraPreviewController(onCapture: onCapture, onCancel: onCancel, onError: onError)
                        .ignoresSafeArea()
                } else {
                    CameraUnavailableView(onCancel: onCancel)
                }
            case .notDetermined:
                CameraPermissionRequestView()
                    .task {
                        let granted = await AVCaptureDevice.requestAccess(for: .video)
                        authorizationStatus = granted ? .authorized : .denied
                    }
            default:
                CameraPermissionDeniedView(onCancel: onCancel)
            }
        }
        .onChange(of: scenePhase) { _, newPhase in
            guard newPhase == .active else { return }
            authorizationStatus = AVCaptureDevice.authorizationStatus(for: .video)
        }
    }

    /// A simulator or other camera-less device cannot create a capture input.
    /// Decide that before constructing the UIKit preview so rendering never
    /// synchronously dismisses the presentation through `onError`.
    private var hasBackCamera: Bool {
        AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back) != nil
    }
}

private struct CameraPermissionRequestView: View {
    var body: some View {
        ProgressView("capturing")
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .accessibilityIdentifier(FieldAccessibilityID.cameraPermissionRequesting)
    }
}

private struct CameraPermissionDeniedView: View {
    let onCancel: () -> Void

    var body: some View {
        VStack(spacing: 16) {
            Image(systemName: "camera.fill")
                .font(.largeTitle)
                .foregroundStyle(.secondary)
            Text("camera_permission_denied")
                .multilineTextAlignment(.center)
                .accessibilityIdentifier(FieldAccessibilityID.cameraPermissionDenied)
            Button("camera_open_settings") {
                if let url = URL(string: UIApplication.openSettingsURLString) {
                    UIApplication.shared.open(url)
                }
            }
            .accessibilityIdentifier(FieldAccessibilityID.cameraOpenSettingsButton)
            Button("camera_cancel", action: onCancel)
                .accessibilityIdentifier(FieldAccessibilityID.cameraCancelButton)
        }
        .padding()
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

private struct CameraUnavailableView: View {
    let onCancel: () -> Void

    var body: some View {
        VStack(spacing: 16) {
            Image(systemName: "camera.fill")
                .font(.largeTitle)
                .foregroundStyle(.secondary)
            Text("camera_unavailable")
                .multilineTextAlignment(.center)
                .accessibilityIdentifier(FieldAccessibilityID.cameraUnavailable)
            Button("camera_cancel", action: onCancel)
                .accessibilityIdentifier(FieldAccessibilityID.cameraCancelButton)
        }
        .padding()
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

private struct CameraPreviewController: UIViewControllerRepresentable {
    let onCapture: (URL) -> Void
    let onCancel: () -> Void
    let onError: () -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(onCapture: onCapture, onError: onError)
    }

    func makeUIViewController(context: Context) -> UIViewController {
        let controller = UIViewController()
        let session = AVCaptureSession()
        session.sessionPreset = .photo

        guard
            let device = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back),
            let input = try? AVCaptureDeviceInput(device: device),
            session.canAddInput(input)
        else {
            // CameraCaptureView preflights the no-device state. Reaching this
            // branch means a real setup failure after that preflight.
            reportSetupError()
            return controller
        }
        session.addInput(input)

        let photoOutput = AVCapturePhotoOutput()
        guard session.canAddOutput(photoOutput) else {
            reportSetupError()
            return controller
        }
        session.addOutput(photoOutput)
        context.coordinator.photoOutput = photoOutput

        let previewLayer = AVCaptureVideoPreviewLayer(session: session)
        previewLayer.videoGravity = .resizeAspectFill
        controller.view.layer.addSublayer(previewLayer)

        var cancelConfiguration = UIButton.Configuration.gray()
        cancelConfiguration.title = String(localized: "camera_cancel")
        let cancel = UIButton(configuration: cancelConfiguration)
        cancel.accessibilityIdentifier = FieldAccessibilityID.cameraCancelButton
        cancel.addAction(UIAction { _ in onCancel() }, for: .touchUpInside)
        cancel.translatesAutoresizingMaskIntoConstraints = false

        var shutterConfiguration = UIButton.Configuration.filled()
        shutterConfiguration.title = String(localized: "camera_shutter")
        shutterConfiguration.cornerStyle = .capsule
        let shutter = UIButton(configuration: shutterConfiguration)
        shutter.accessibilityIdentifier = FieldAccessibilityID.cameraShutterButton
        shutter.addAction(UIAction { _ in
            photoOutput.capturePhoto(with: AVCapturePhotoSettings(), delegate: context.coordinator)
        }, for: .touchUpInside)
        shutter.translatesAutoresizingMaskIntoConstraints = false

        controller.view.addSubview(cancel)
        controller.view.addSubview(shutter)
        NSLayoutConstraint.activate([
            cancel.leadingAnchor.constraint(equalTo: controller.view.safeAreaLayoutGuide.leadingAnchor, constant: 20),
            cancel.topAnchor.constraint(equalTo: controller.view.safeAreaLayoutGuide.topAnchor, constant: 20),
            cancel.widthAnchor.constraint(greaterThanOrEqualToConstant: 44),
            cancel.heightAnchor.constraint(greaterThanOrEqualToConstant: 44),
            shutter.centerXAnchor.constraint(equalTo: controller.view.centerXAnchor),
            shutter.bottomAnchor.constraint(equalTo: controller.view.safeAreaLayoutGuide.bottomAnchor, constant: -28),
            shutter.widthAnchor.constraint(greaterThanOrEqualToConstant: 80),
            shutter.heightAnchor.constraint(greaterThanOrEqualToConstant: 80),
        ])

        let sessionRunner = CameraSessionRunner(session: session)
        sessionRunner.start()

        context.coordinator.previewLayer = previewLayer
        context.coordinator.sessionRunner = sessionRunner
        return controller
    }

    /// SwiftUI may invoke `makeUIViewController` while updating its view tree.
    /// Defer the parent-owned error transition so setup failure never mutates
    /// SwiftUI state synchronously during render construction.
    private func reportSetupError() {
        DispatchQueue.main.async {
            onError()
        }
    }

    func updateUIViewController(_ uiViewController: UIViewController, context: Context) {
        context.coordinator.previewLayer?.frame = uiViewController.view.bounds
    }

    final class Coordinator: NSObject, AVCapturePhotoCaptureDelegate {
        let onCapture: (URL) -> Void
        let onError: () -> Void
        var photoOutput: AVCapturePhotoOutput?
        var previewLayer: AVCaptureVideoPreviewLayer?
        var sessionRunner: CameraSessionRunner?

        init(onCapture: @escaping (URL) -> Void, onError: @escaping () -> Void) {
            self.onCapture = onCapture
            self.onError = onError
        }

        func photoOutput(
            _ output: AVCapturePhotoOutput,
            didFinishProcessingPhoto photo: AVCapturePhoto,
            error: Error?
        ) {
            guard error == nil, let data = photo.fileDataRepresentation() else {
                onError()
                return
            }
            let url = FileManager.default.temporaryDirectory
                .appendingPathComponent("evidence-\(UUID().uuidString.lowercased()).jpg")
            do {
                try data.write(to: url, options: [.atomic])
                onCapture(url)
            } catch {
                onError()
            }
        }

        deinit {
            sessionRunner?.stop()
        }
    }
}

private final class CameraSessionRunner: @unchecked Sendable {
    private let queue = DispatchQueue(label: "com.maintenance.field.camera-session")
    private let session: AVCaptureSession

    init(session: AVCaptureSession) {
        self.session = session
    }

    func start() {
        queue.async { [self] in
            session.startRunning()
        }
    }

    func stop() {
        queue.async { [self] in
            if session.isRunning {
                session.stopRunning()
            }
        }
    }
}
#else
struct CameraCaptureView: View {
    let onCapture: (URL) -> Void
    let onCancel: () -> Void
    let onError: () -> Void

    var body: some View {
        VStack(spacing: 16) {
            Text("camera_unavailable")
                .accessibilityIdentifier(FieldAccessibilityID.cameraUnavailable)
            Button("camera_cancel", action: onCancel)
                .accessibilityIdentifier(FieldAccessibilityID.cameraCancelButton)
        }
        .padding()
    }
}
#endif
