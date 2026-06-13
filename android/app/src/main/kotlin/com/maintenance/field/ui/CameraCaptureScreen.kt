package com.maintenance.field.ui

import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageCapture
import androidx.camera.core.ImageCaptureException
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.systemBars
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.maintenance.field.R
import java.io.File
import java.util.UUID

@Composable
fun CameraCaptureScreen(
    modifier: Modifier = Modifier,
    onCancel: () -> Unit,
    onCaptured: (File) -> Unit,
    onError: (Throwable) -> Unit,
) {
    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current
    val previewView = remember {
        PreviewView(context).apply {
            implementationMode = PreviewView.ImplementationMode.COMPATIBLE
            scaleType = PreviewView.ScaleType.FILL_CENTER
        }
    }
    val imageCapture = remember {
        ImageCapture.Builder()
            .setCaptureMode(ImageCapture.CAPTURE_MODE_MINIMIZE_LATENCY)
            .build()
    }
    var isCapturing by remember { mutableStateOf(false) }

    DisposableEffect(context, lifecycleOwner, previewView, imageCapture) {
        val cameraProviderFuture = ProcessCameraProvider.getInstance(context)
        val executor = ContextCompat.getMainExecutor(context)
        val listener = Runnable {
            try {
                val cameraProvider = cameraProviderFuture.get()
                val preview = Preview.Builder().build().also {
                    it.setSurfaceProvider(previewView.surfaceProvider)
                }
                cameraProvider.unbindAll()
                cameraProvider.bindToLifecycle(
                    lifecycleOwner,
                    CameraSelector.DEFAULT_BACK_CAMERA,
                    preview,
                    imageCapture,
                )
            } catch (error: Exception) {
                onError(error)
            }
        }
        cameraProviderFuture.addListener(listener, executor)
        onDispose {
            if (cameraProviderFuture.isDone) {
                runCatching { cameraProviderFuture.get().unbindAll() }
            }
        }
    }

    Box(
        modifier = modifier
            .fillMaxSize()
            .background(Color.Black),
    ) {
        AndroidView(
            factory = { previewView },
            modifier = Modifier.fillMaxSize(),
        )
        Row(
            modifier = Modifier
                .align(Alignment.BottomCenter)
                .fillMaxWidth()
                .padding(WindowInsets.systemBars.asPaddingValues())
                .padding(16.dp),
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            OutlinedButton(
                onClick = onCancel,
                modifier = Modifier
                    .weight(1f)
                    .heightIn(min = 48.dp),
            ) {
                Text(stringResource(R.string.camera_cancel))
            }
            Button(
                onClick = {
                    isCapturing = true
                    val output = File(context.cacheDir, "evidence-${UUID.randomUUID()}.jpg")
                    val options = ImageCapture.OutputFileOptions.Builder(output).build()
                    imageCapture.takePicture(
                        options,
                        ContextCompat.getMainExecutor(context),
                        object : ImageCapture.OnImageSavedCallback {
                            override fun onImageSaved(outputFileResults: ImageCapture.OutputFileResults) {
                                isCapturing = false
                                onCaptured(output)
                            }

                            override fun onError(exception: ImageCaptureException) {
                                isCapturing = false
                                onError(exception)
                            }
                        },
                    )
                },
                enabled = !isCapturing,
                modifier = Modifier
                    .weight(1f)
                    .heightIn(min = 48.dp),
            ) {
                Text(
                    text = stringResource(
                        if (isCapturing) R.string.capturing else R.string.camera_shutter,
                    ),
                    style = MaterialTheme.typography.labelLarge,
                )
            }
        }
    }
}
