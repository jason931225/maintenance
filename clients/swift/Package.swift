// swift-tools-version:6.0

import PackageDescription

let package = Package(
    name: "MaintenanceAPIClient",
    platforms: [
        .macOS(.v10_15),
        .iOS(.v13),
        .tvOS(.v13),
        .watchOS(.v6),
        .visionOS(.v1),
    ],
    products: [
        .library(name: "MaintenanceAPIClient", targets: ["MaintenanceAPIClient"]),
    ],
    dependencies: [
        .package(url: "https://github.com/apple/swift-openapi-runtime", exact: "1.12.0"),
    ],
    targets: [
        .target(
            name: "MaintenanceAPIClient",
            dependencies: [
                .product(name: "OpenAPIRuntime", package: "swift-openapi-runtime"),
            ]
        ),
    ]
)
