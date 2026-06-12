package com.maintenance.field.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import com.maintenance.field.R

private val FieldColorScheme = lightColorScheme(
    primary = Color(0xFF146C5C),
    onPrimary = Color.White,
    secondary = Color(0xFF4E5F68),
    onSecondary = Color.White,
    tertiary = Color(0xFF8A5A00),
    background = Color(0xFFF7F9F7),
    surface = Color.White,
    surfaceVariant = Color(0xFFE4EBE8),
    outline = Color(0xFF6F7975),
    error = Color(0xFFB3261E),
)

private val Pretendard = FontFamily(Font(R.font.pretendard))

@Composable
fun FieldTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = FieldColorScheme,
        typography = MaterialTheme.typography.copy(
            displayLarge = MaterialTheme.typography.displayLarge.copy(fontFamily = Pretendard),
            displayMedium = MaterialTheme.typography.displayMedium.copy(fontFamily = Pretendard),
            displaySmall = MaterialTheme.typography.displaySmall.copy(fontFamily = Pretendard),
            headlineLarge = MaterialTheme.typography.headlineLarge.copy(fontFamily = Pretendard),
            headlineMedium = MaterialTheme.typography.headlineMedium.copy(fontFamily = Pretendard),
            headlineSmall = MaterialTheme.typography.headlineSmall.copy(fontFamily = Pretendard),
            titleLarge = MaterialTheme.typography.titleLarge.copy(fontFamily = Pretendard),
            titleMedium = MaterialTheme.typography.titleMedium.copy(fontFamily = Pretendard),
            titleSmall = MaterialTheme.typography.titleSmall.copy(fontFamily = Pretendard),
            bodyLarge = MaterialTheme.typography.bodyLarge.copy(fontFamily = Pretendard),
            bodyMedium = MaterialTheme.typography.bodyMedium.copy(fontFamily = Pretendard),
            bodySmall = MaterialTheme.typography.bodySmall.copy(fontFamily = Pretendard),
            labelLarge = MaterialTheme.typography.labelLarge.copy(fontFamily = Pretendard),
            labelMedium = MaterialTheme.typography.labelMedium.copy(fontFamily = Pretendard),
            labelSmall = MaterialTheme.typography.labelSmall.copy(fontFamily = Pretendard),
        ),
        content = content,
    )
}
