import SwiftUI

@main
struct MaintenanceFieldApp: App {
    private let container = FieldAppContainer.live()

    var body: some Scene {
        WindowGroup {
            FieldRootView(viewModel: FieldViewModel(container: container))
        }
    }
}
