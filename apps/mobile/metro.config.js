// Metro config for a workspace layout.
//
// The app imports @uberapp/protocol, which lives in this repo rather than in
// the registry. Metro does not follow symlinks out of the project by default,
// so the workspace root has to be watched explicitly and both node_modules
// directories declared.

const { getDefaultConfig } = require('expo/metro-config');
const path = require('node:path');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);

config.watchFolders = [workspaceRoot];

config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];

// Without this, a hoisted dependency can be resolved twice and React ends up
// duplicated.
config.resolver.disableHierarchicalLookup = true;

module.exports = config;
