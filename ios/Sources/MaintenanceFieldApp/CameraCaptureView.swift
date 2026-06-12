import SwiftUI

#if os(iOS)
import AVFoundation
import UIKit

struct CameraCaptureView: View {
    let onCapture: (URL) -> Void
    let onCancel: () -> Void

    var body: some View {
        CameraPreviewController(onCapture: onCapture, onCancel: onCancel)
            .ignoresSafeArea()
    }
}

private struct CameraPreviewController: UIViewControllerRepresentable {
    let onCapture: (URL) -> Void
    let onCancel: () -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(onCapture: onCapture)
    }

    func makeUIViewController(context: Context) -> UIViewController {
        let controller = UIViewController()
        let session = AVCaptureSession()
        session.sessionPreset = .photo

        if let device = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back),
           let input = try? AVCaptureDeviceInput(device: device),
           session.canAddInput(input) {
            session.addInput(input)
        }

        let photoOutput = AVCapturePhotoOutput()
        if session.canAddOutput(photoOutput) {
            session.addOutput(photoOutput)
        }
        context.coordinator.photoOutput = photoOutput

        let previewLayer = AVCaptureVideoPreviewLayer(session: session)
        previewLayer.videoGravity = .resizeAspectFill
        controller.view.layer.addSublayer(previewLayer)

        let cancel = UIButton(type: .system)
        cancel.setTitle(String(localized: "camera_cancel"), for: .normal)
        cancel.addAction(UIAction { _ in onCancel() }, for: .touchUpInside)
        cancel.translatesAutoresizingMaskIntoConstraints = false

        let shutter = UIButton(type: .system)
        shutter.setTitle(String(localized: "camera_shutter"), for: .normal)
        shutter.addAction(UIAction { _ in
            photoOutput.capturePhoto(with: AVCapturePhotoSettings(), delegate: context.coordinator)
        }, for: .touchUpInside)
        shutter.translatesAutoresizingMaskIntoConstraints = false

        controller.view.addSubview(cancel)
        controller.view.addSubview(shutter)
        NSLayoutConstraint.activate([
            cancel.leadingAnchor.constraint(equalTo: controller.view.safeAreaLayoutGuide.leadingAnchor, constant: 20),
            cancel.topAnchor.constraint(equalTo: controller.view.safeAreaLayoutGuide.topAnchor, constant: 20),
            shutter.centerXAnchor.constraint(equalTo: controller.view.centerXAnchor),
            shutter.bottomAnchor.constraint(equalTo: controller.view.safeAreaLayoutGuide.bottomAnchor, constant: -28),
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
        var photoOutput: AVCapturePhotoOutput?
        var previewLayer: AVCaptureVideoPreviewLayer?
        var session: AVCaptureSession?

        init(onCapture: @escaping (URL) -> Void) {
            self.onCapture = onCapture
        }

        func photoOutput(
            _ output: AVCapturePhotoOutput,
            didFinishProcessingPhoto photo: AVCapturePhoto,
            error: Error?
        ) {
            guard error == nil, let data = photo.fileDataRepresentation() else { return }
            let url = FileManager.default.temporaryDirectory
                .appendingPathComponent("evidence-\(UUID().uuidString.lowercased()).jpg")
            do {
                try data.write(to: url, options: [.atomic])
                onCapture(url)
            } catch {
                return
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

    var body: some View {
        VStack(spacing: 16) {
            Text("camera_unavailable")
            Button("camera_cancel", action: onCancel)
        }
        .padding()
    }
}
#endif
