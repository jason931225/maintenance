import SwiftUI

#if os(iOS)
import AVFoundation
import UIKit

struct CameraCaptureView: View {
    let onCapture: (URL) -> Void
    let onCancel: () -> Void
    let onError: () -> Void

    @State private var authorizationStatus = AVCaptureDevice.authorizationStatus(for: .video)

    var body: some View {
        Group {
            switch authorizationStatus {
            case .authorized:
                CameraPreviewController(onCapture: onCapture, onCancel: onCancel, onError: onError)
                    .ignoresSafeArea()
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
    }
}

private struct CameraPermissionRequestView: View {
    var body: some View {
        ProgressView("capturing")
            .frame(maxWidth: .infinity, maxHeight: .infinity)
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
            Button("camera_open_settings") {
                if let url = URL(string: UIApplication.openSettingsURLString) {
                    UIApplication.shared.open(url)
                }
            }
            Button("camera_cancel", action: onCancel)
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
            onError()
            return controller
        }
        session.addInput(input)

        let photoOutput = AVCapturePhotoOutput()
        guard session.canAddOutput(photoOutput) else {
            onError()
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
        cancel.addAction(UIAction { _ in onCancel() }, for: .touchUpInside)
        cancel.translatesAutoresizingMaskIntoConstraints = false

        var shutterConfiguration = UIButton.Configuration.filled()
        shutterConfiguration.title = String(localized: "camera_shutter")
        shutterConfiguration.cornerStyle = .capsule
        let shutter = UIButton(configuration: shutterConfiguration)
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

        Task.detached {
            session.startRunning()
        }

        context.coordinator.previewLayer = previewLayer
        context.coordinator.session = session
        return controller
    }

    func updateUIViewController(_ uiViewController: UIViewController, context: Context) {
        context.coordinator.previewLayer?.frame = uiViewController.view.bounds
    }

    final class Coordinator: NSObject, AVCapturePhotoCaptureDelegate {
        let onCapture: (URL) -> Void
        let onError: () -> Void
        var photoOutput: AVCapturePhotoOutput?
        var previewLayer: AVCaptureVideoPreviewLayer?
        var session: AVCaptureSession?

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
            session?.stopRunning()
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
            Button("camera_cancel", action: onCancel)
        }
        .padding()
    }
}
#endif
