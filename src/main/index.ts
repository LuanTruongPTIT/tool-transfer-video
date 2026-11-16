import { app, BrowserWindow, dialog, ipcMain, powerSaveBlocker, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { ConfigStore } from './configStore';
import { FolderWatcher } from './folderWatcher';
import { AuthManager } from './authManager';
import { LanServer } from './lanServer';
import { LocalSendBridge } from './localSendBridge';
import { discoverLanInterfaces } from './networkUtils';
import { DesktopAppState } from '../shared/types';

let mainWindow: BrowserWindow | null = null;
let configStore: ConfigStore;
let folderWatcher: FolderWatcher;
let authManager: AuthManager;
let lanServer: LanServer;
let localSendBridge: LocalSendBridge;
let networkMonitorTimer: NodeJS.Timeout | null = null;
let powerSaveId: number | null = null;

function buildAppState(): DesktopAppState {
  const snap = folderWatcher.getSnapshot();
  return {
    watchedFolder: folderWatcher.getWatchedFolder(),
    filterRecent24h: folderWatcher.getFilterRecent24h(),
    totalVideosInFolder: snap.totalVideosInFolder,
    hiddenOlderCount: snap.hiddenOlderCount,
    activeBrowserDownloadsCount: snap.activeBrowserDownloadsCount,
    videos: snap.videos,
    pairing: lanServer.getPairingInfo(),
    localSend: localSendBridge.getState(),
    icloudShortcutUrl: configStore.get().icloudShortcutUrl,
    platform: process.platform
  };
}

function broadcastStateToRenderer(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('evd:stateChanged', buildAppState());
}

async function startLanAndSyncLocalSend(
  preferredAddress: string | null,
  preferredPort: number
): Promise<void> {
  await lanServer.start(preferredAddress, preferredPort);
  const info = lanServer.getPairingInfo();
  if (info.serverRunning && info.lanIp) {
    await localSendBridge.startDiscovery(info.lanIp, info.port);
    const priorityIps = info.pairedDevice ? [info.pairedDevice.ipAddress] : [];
    void localSendBridge.scanPeers(priorityIps);
  } else {
    localSendBridge.stopDiscovery();
  }
}

async function initializeBackend(): Promise<void> {
  const userDataDir = app.getPath('userData');
  configStore = new ConfigStore(userDataDir);
  const cfg = configStore.get();

  folderWatcher = new FolderWatcher({
    stabilityWindowMs: 2000,
    pollIntervalMs: 500
  });
  folderWatcher.setFilterRecent24h(cfg.filterRecent24h);

  authManager = new AuthManager({
    sessionTtlMs: 10 * 60 * 60 * 1000, // 10 hours (1 work shift)
    mediaTicketTtlMs: 10 * 60 * 1000,
    maxPinAttempts: 5
  });

  const rendererDistDir = path.join(__dirname, '..', 'renderer');
  lanServer = new LanServer(folderWatcher, authManager, {
    rendererDistDir,
    getIcloudShortcutUrl: () => configStore.get().icloudShortcutUrl
  });

  localSendBridge = new LocalSendBridge(folderWatcher, lanServer.getMkvRemuxer(), {
    fingerprint: cfg.localSendFingerprint,
    privateKeyPem: cfg.localSendPrivateKeyPem,
    certificatePem: cfg.localSendCertPem,
    initialSelectedPeer: cfg.localSendSelectedPeer,
    initialAutoPush: cfg.localSendAutoPush,
    initialPin: cfg.localSendPin
  });
  lanServer.setLocalSendBridge(localSendBridge);

  let lastSavedPeerKey = JSON.stringify(cfg.localSendSelectedPeer ?? null);

  folderWatcher.on('change', () => broadcastStateToRenderer());
  lanServer.on('change', () => broadcastStateToRenderer());
  localSendBridge.on('change', () => {
    const currentPeer = localSendBridge.getState().selectedPeer;
    const nextPeerKey = JSON.stringify(currentPeer ?? null);
    if (nextPeerKey !== lastSavedPeerKey) {
      lastSavedPeerKey = nextPeerKey;
      configStore.update({ localSendSelectedPeer: currentPeer });
    }
    broadcastStateToRenderer();
  });

  authManager.on('change', () => {
    const paired = authManager.getPairedDevice();
    if (paired?.ipAddress) {
      void localSendBridge.probeSingleHost(paired.ipAddress);
    }
  });

  if (cfg.watchedFolder) {
    try {
      await folderWatcher.startWatching(cfg.watchedFolder);
    } catch {
      configStore.update({ watchedFolder: null });
    }
  }

  await startLanAndSyncLocalSend(cfg.preferredInterfaceAddress, cfg.preferredPort);

  // Monitor LAN DHCP renewals or Wi-Fi changes every 10 seconds
  networkMonitorTimer = setInterval(() => {
    const info = lanServer.getPairingInfo();
    const interfaces = discoverLanInterfaces();

    if (!info.serverRunning && interfaces.length > 0) {
      const latestCfg = configStore.get();
      void startLanAndSyncLocalSend(latestCfg.preferredInterfaceAddress, latestCfg.preferredPort);
      return;
    }

    if (info.serverRunning && info.lanIp) {
      const stillValid = interfaces.some((iface) => iface.address === info.lanIp);
      if (!stillValid) {
        const latestCfg = configStore.get();
        void startLanAndSyncLocalSend(latestCfg.preferredInterfaceAddress, latestCfg.preferredPort);
      }
    }
  }, 10000);
}

function registerIpcHandlers(): void {
  ipcMain.handle('evd:getState', () => buildAppState());

  ipcMain.handle('evd:selectFolder', async () => {
    const options: Electron.OpenDialogOptions = {
      title: 'Chọn thư mục theo dõi video AI (OpenArt / Google Flow)',
      buttonLabel: 'Chọn thư mục này',
      properties: ['openDirectory', 'dontAddToRecent']
    };
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options);

    if (!result.canceled && result.filePaths.length > 0) {
      const chosen = result.filePaths[0];
      await folderWatcher.startWatching(chosen);
      configStore.update({ watchedFolder: chosen });
    }
    return buildAppState();
  });

  ipcMain.handle('evd:setFolder', async (_evt, folderPath: string) => {
    if (typeof folderPath === 'string' && folderPath.trim()) {
      await folderWatcher.startWatching(folderPath.trim());
      configStore.update({ watchedFolder: folderPath.trim() });
    }
    return buildAppState();
  });

  ipcMain.handle('evd:setFilterRecent24h', (_evt, recent24h: boolean) => {
    const val = Boolean(recent24h);
    folderWatcher.setFilterRecent24h(val);
    configStore.update({ filterRecent24h: val });
    return buildAppState();
  });

  ipcMain.handle('evd:selectNetworkInterface', async (_evt, address: string) => {
    if (typeof address === 'string' && address.trim()) {
      configStore.update({ preferredInterfaceAddress: address.trim() });
      const cfg = configStore.get();
      await startLanAndSyncLocalSend(cfg.preferredInterfaceAddress, cfg.preferredPort);
    }
    return buildAppState();
  });

  ipcMain.handle('evd:refreshNetwork', async () => {
    const cfg = configStore.get();
    await startLanAndSyncLocalSend(cfg.preferredInterfaceAddress, cfg.preferredPort);
    return buildAppState();
  });

  ipcMain.handle('evd:rotatePairingCredentials', () => {
    authManager.rotateCredentials();
    return buildAppState();
  });

  ipcMain.handle('evd:disconnectPairedDevice', () => {
    authManager.disconnectPairedDevice();
    return buildAppState();
  });

  ipcMain.handle('evd:openWatchedFolderInExplorer', async () => {
    const folder = folderWatcher.getWatchedFolder();
    if (folder) {
      await shell.openPath(folder);
    }
  });

  ipcMain.handle('evd:scanLocalSendPeers', async () => {
    const paired = authManager.getPairedDevice();
    const priorityIps = paired?.ipAddress ? [paired.ipAddress] : [];
    void localSendBridge.scanPeers(priorityIps);
    return buildAppState();
  });

  ipcMain.handle('evd:addManualLocalSendPeer', async (_evt, ip: string, port?: number) => {
    if (typeof ip === 'string' && ip.trim()) {
      await localSendBridge.connectManualIp(ip, port);
    }
    return buildAppState();
  });

  ipcMain.handle('evd:selectLocalSendPeer', (_evt, fingerprintOrNull: string | null) => {
    const chosen = localSendBridge.selectPeer(
      typeof fingerprintOrNull === 'string' && fingerprintOrNull ? fingerprintOrNull : null
    );
    configStore.update({ localSendSelectedPeer: chosen });
    return buildAppState();
  });

  ipcMain.handle('evd:setLocalSendAutoPush', (_evt, enabled: boolean) => {
    const val = Boolean(enabled);
    localSendBridge.setAutoPush(val);
    configStore.update({ localSendAutoPush: val });
    return buildAppState();
  });

  ipcMain.handle('evd:setLocalSendPin', (_evt, pin: string) => {
    const cleanPin = typeof pin === 'string' ? pin.trim() : '';
    localSendBridge.setPin(cleanPin);
    configStore.update({ localSendPin: cleanPin });
    return buildAppState();
  });

  ipcMain.handle('evd:pushVideoViaLocalSend', (_evt, videoId: string) => {
    if (typeof videoId === 'string' && videoId.trim()) {
      localSendBridge.enqueueVideoPush(videoId.trim());
    }
    return buildAppState();
  });

  ipcMain.handle('evd:setIcloudShortcutUrl', (_evt, rawUrl: string) => {
    const trimmed = typeof rawUrl === 'string' ? rawUrl.trim() : '';
    const validShortcutLink =
      trimmed === ''
        ? null
        : /^https:\/\/(www\.)?icloud\.com\/shortcuts\/[A-Za-z0-9]+/i.test(trimmed)
          ? trimmed
          : configStore.get().icloudShortcutUrl;
    configStore.update({ icloudShortcutUrl: validShortcutLink });
    lanServer.notifyExternalConfigChanged();
    return buildAppState();
  });
}

const APP_ID = 'com.ecomvideodrop.app';

function resolveAppIconPngPath(): string | undefined {
  const candidate = path.join(__dirname, '..', '..', 'build', 'icon.png');
  return fs.existsSync(candidate) ? candidate : undefined;
}

async function createMainWindow(): Promise<void> {
  const iconPath = resolveAppIconPngPath();
  mainWindow = new BrowserWindow({
    width: 1120,
    height: 760,
    minWidth: 920,
    minHeight: 640,
    title: 'Ecom Video Drop',
    icon: iconPath,
    backgroundColor: '#f8fafc',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  const desktopHtml = path.join(__dirname, '..', 'renderer', 'desktop', 'index.html');
  await mainWindow.loadFile(desktopHtml);

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

if (process.platform === 'win32') {
  app.setAppUserModelId(APP_ID);
}

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  void app.whenReady().then(async () => {
    const iconPath = resolveAppIconPngPath();
    if (process.platform === 'darwin' && app.dock && iconPath) {
      app.dock.setIcon(iconPath);
    }
    powerSaveId = powerSaveBlocker.start('prevent-app-suspension');
    await initializeBackend();
    registerIpcHandlers();
    await createMainWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        void createMainWindow();
      }
    });
  });
}

app.on('window-all-closed', () => {
  app.quit();
});

app.on('before-quit', () => {
  if (networkMonitorTimer) {
    clearInterval(networkMonitorTimer);
    networkMonitorTimer = null;
  }
  if (powerSaveId !== null && powerSaveBlocker.isStarted(powerSaveId)) {
    powerSaveBlocker.stop(powerSaveId);
  }
  void folderWatcher?.stopWatching();
  localSendBridge?.stopDiscovery();
  void lanServer?.stop();
});
