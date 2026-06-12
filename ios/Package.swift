// swift-tools-version:6.1

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
            resources: [
                .process("Resources"),
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
