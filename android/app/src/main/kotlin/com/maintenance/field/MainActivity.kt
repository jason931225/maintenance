package com.maintenance.field

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import com.maintenance.field.ui.FieldApp
import com.maintenance.field.ui.theme.FieldTheme

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val container = (application as MaintenanceFieldApplication).container
        setContent {
            FieldTheme {
                FieldApp(container = container)
            }
        }
    }
}
