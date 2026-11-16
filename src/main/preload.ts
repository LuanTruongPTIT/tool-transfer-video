import { contextBridge, ipcRenderer } from 'electron';
import { DesktopAppState, DesktopBridgeApi } from '../shared/types';

const api: DesktopBridgeApi = {
  getState: () => ipcRenderer.invoke('evd:getState'),
  selectFolder: () => ipcRenderer.invoke('evd:selectFolder'),
  setFolder: (folderPath: string) => ipcRenderer.invoke('evd:setFolder', folderPath),
  setFilterRecent24h: (recent24h: boolean) =>
    ipcRenderer.invoke('evd:setFilterRecent24h', recent24h),
  selectNetworkInterface: (address: string) =>
    ipcRenderer.invoke('evd:selectNetworkInterface', address),
  refreshNetwork: () => ipcRenderer.invoke('evd:refreshNetwork'),
  rotatePairingCredentials: () => ipcRenderer.invoke('evd:rotatePairingCredentials'),
  disconnectPairedDevice: () => ipcRenderer.invoke('evd:disconnectPairedDevice'),
  openWatchedFolderInExplorer: () => ipcRenderer.invoke('evd:openWatchedFolderInExplorer'),
  scanLocalSendPeers: () => ipcRenderer.invoke('evd:scanLocalSendPeers'),
  addManualLocalSendPeer: (ip: string, port?: number) =>
    ipcRenderer.invoke('evd:addManualLocalSendPeer', ip, port),
  selectLocalSendPeer: (fingerprintOrNull: string | null) =>
    ipcRenderer.invoke('evd:selectLocalSendPeer', fingerprintOrNull),
  setLocalSendAutoPush: (enabled: boolean) =>
    ipcRenderer.invoke('evd:setLocalSendAutoPush', enabled),
  setLocalSendPin: (pin: string) => ipcRenderer.invoke('evd:setLocalSendPin', pin),
  pushVideoViaLocalSend: (videoId: string) =>
    ipcRenderer.invoke('evd:pushVideoViaLocalSend', videoId),
  setIcloudShortcutUrl: (url: string) => ipcRenderer.invoke('evd:setIcloudShortcutUrl', url),
  onStateChanged: (callback: (state: DesktopAppState) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, state: DesktopAppState) => {
      callback(state);
    };
    ipcRenderer.on('evd:stateChanged', handler);
    return () => {
      ipcRenderer.removeListener('evd:stateChanged', handler);
    };
  }
};

contextBridge.exposeInMainWorld('ecomVideoDrop', api);
