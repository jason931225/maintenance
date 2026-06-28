import react from '@vitejs/plugin-react';
import path from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  define: {
    __DEV__: JSON.stringify(process.env.NODE_ENV !== 'production'),
  },
  optimizeDeps: {
    exclude: ['react-native', 'react-native-video'],
  },
  resolve: {
    alias: [
      { find: /^react-native$/, replacement: 'react-native-web' },
      { find: 'react-native-video', replacement: path.resolve(__dirname, 'src/web/reactNativeVideoShim.tsx') },
    ],
    extensions: ['.web.tsx', '.web.ts', '.tsx', '.ts', '.web.jsx', '.web.js', '.jsx', '.js', '.json'],
  },
  server: {
    host: '127.0.0.1',
    port: 8082,
    strictPort: true,
  },
});
