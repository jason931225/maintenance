const path = require('path');
const {getDefaultConfig, mergeConfig} = require('@react-native/metro-config');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '..');
const workspaceNodeModules = path.resolve(workspaceRoot, 'node_modules');

/**
 * Metro config for the local COSS React Native preview.
 * React Native uses Metro to build JavaScript and assets:
 * https://reactnative.dev/docs/metro
 *
 * @type {import('@react-native/metro-config').MetroConfig}
 */
module.exports = mergeConfig(getDefaultConfig(projectRoot), {
  projectRoot,
  watchFolders: [workspaceNodeModules],
  resolver: {
    nodeModulesPaths: [
      path.resolve(projectRoot, 'node_modules'),
      workspaceNodeModules,
    ],
    extraNodeModules: {
      '@babel/runtime': path.resolve(workspaceNodeModules, '@babel/runtime'),
      react: path.resolve(workspaceNodeModules, 'react'),
      'react-native': path.resolve(workspaceNodeModules, 'react-native'),
      'react-native-video': path.resolve(workspaceNodeModules, 'react-native-video'),
    },
  },
});
