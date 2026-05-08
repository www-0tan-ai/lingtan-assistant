/**
 * Lingtan Assistant — preload.
 *
 * The Hermes Web UI is a vanilla browser app and needs no bridge today,
 * but exposing a tiny, frozen surface here keeps a clean upgrade path for
 * future features (window controls, native notifications, etc.) without
 * having to relax contextIsolation.
 */

const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('lingtan', Object.freeze({
  isElectron: true,
  versions: {
    app: process.env.npm_package_version || null,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },
}));
