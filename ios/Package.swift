// swift-tools-version:6.0

import PackageDescription

let package = Package(
    name: "MaintenanceField",
    defaultLocalization: "ko",
    platforms: [
        .iOS(.v16),
        .macOS(.v14),
    ],
    products: [
        .library(name: "MaintenanceFieldCore", targets: ["MaintenanceFieldCore"]),
        .executable(name: "MaintenanceFieldApp", targets: ["MaintenanceFieldApp"]),
    ],
    dependencies: [
        .package(path: "../clients/swift"),
        .package(url: "https://github.com/apple/swift-openapi-urlsession", exact: "1.3.0"),
    ],
    targets: [
        .target(
            name: "MaintenanceFieldCore",
            dependencies: [
                .product(name: "MaintenanceAPIClient", package: "swift"),
                .product(name: "OpenAPIURLSession", package: "swift-openapi-urlsession"),
            ]
        ),
        .executableTarget(
            name: "MaintenanceFieldApp",
            dependencies: ["MaintenanceFieldCore"],
            // Info.plist is consumed by the linker (see linkerSettings below), not as a
            // bundle resource, so exclude it from SwiftPM resource processing.
            exclude: ["Info.plist"],
            resources: [
                .process("Resources"),
            ],
            // Embed Info.plist (with NSCameraUsageDescription) into the executable's
            // Mach-O __TEXT,__info_plist section. SwiftPM executable targets have no
            // `infoPlist` setting, so this linker section is the supported way to make
            // the camera usage-description string travel with a SwiftPM-built binary.
            // The path is resolved relative to the package root.
            // NOTE (Xcode app-target packaging): when this package is wrapped in an
            // Xcode app target for App Store / device distribution, the app target's
            // own Info.plist MUST also declare `NSCameraUsageDescription` (Xcode does
            // not read this embedded section for its bundle Info.plist). See
            // Sources/MaintenanceFieldApp/Info.plist for the canonical Korean copy.
            linkerSettings: [
                .unsafeFlags([
                    "-Xlinker", "-sectcreate",
                    "-Xlinker", "__TEXT",
                    "-Xlinker", "__info_plist",
                    "-Xlinker", "Sources/MaintenanceFieldApp/Info.plist",
                ])
            ]
        ),
        .executableTarget(
            name: "MaintenanceFieldCoreBehaviorTests",
            dependencies: ["MaintenanceFieldCore"]
        ),
        .testTarget(
            name: "MaintenanceFieldCoreTests",
            dependencies: ["MaintenanceFieldCore"]
        ),
    ]
)
