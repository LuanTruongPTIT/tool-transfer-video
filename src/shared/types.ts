export type VideoLifecycleStatus =
  | 'waiting_complete'
  | 'ready'
  | 'transferring'
  | 'downloaded_to_safari'
  | 'saved_to_photos'
  | 'transfer_error'
  | 'invalid';

export type SupportedVideoExtension = 'mp4' | 'mov' | 'm4v' | 'mkv' | 'webm';

export type SupportedVideoMimeType =
  | 'video/mp4'
  | 'video/quicktime'
  | 'video/x-matroska'
  | 'video/webm';

export interface VideoItem {
  id: string;
  fileName: string;
  extension: SupportedVideoExtension;
  mimeType: SupportedVideoMimeType;
  needsIosRemux: boolean;
  sizeBytes: number;
  modifiedAtMs: number;
  detectedAtMs: number;
  status: VideoLifecycleStatus;
  transferredBytes: number;
  transferPercent: number;
  errorMessage?: string;
  downloadedAtMs?: number;
  savedToPhotosAtMs?: number;
  downloadCount: number;
}

export interface MobileVideoItem extends VideoItem {
  previewUrl: string;
  downloadUrl: string;
  rawDownloadUrl?: string;
  iosDownloadFileName: string;
  shortcutSaveUrl: string;
}

export interface LocalSendPeer {
  fingerprint: string;
  alias: string;
  deviceModel: string;
  deviceType: string;
  ip: string;
  port: number;
  protocol: 'http' | 'https';
  lastSeenAtMs: number;
}

export interface LocalSendState {
  senderAlias: string;
  senderFingerprintShort: string;
  discoveredPeers: LocalSendPeer[];
  selectedPeer: LocalSendPeer | null;
  autoPushNewVideos: boolean;
  pin: string;
  scanning: boolean;
  activePushVideoId: string | null;
  lastPushMessage: string | null;
  lastPushError: string | null;
}

export interface NetworkInterfaceOption {
  name: string;
  address: string;
  netmask: string;
  cidr: string | null;
  isPreferredPhysical: boolean;
}

export interface PairedDeviceInfo {
  sessionId: string;
  deviceLabel: string;
  ipAddress: string;
  pairedAtMs: number;
  expiresAtMs: number;
  lastSeenAtMs: number;
}

export interface PairingInfo {
  serverRunning: boolean;
  serverError?: string;
  lanIp: string | null;
  port: number;
  pairUrl: string | null;
  qrDataUrl: string | null;
  pinCode: string;
  failedPinAttempts: number;
  maxPinAttempts: number;
  pairedDevice: PairedDeviceInfo | null;
  availableInterfaces: NetworkInterfaceOption[];
}

export interface DesktopAppState {
  watchedFolder: string | null;
  filterRecent24h: boolean;
  totalVideosInFolder: number;
  hiddenOlderCount: number;
  activeBrowserDownloadsCount: number;
  videos: VideoItem[];
  pairing: PairingInfo;
  localSend: LocalSendState;
  icloudShortcutUrl: string | null;
  platform: string;
}

export interface AppConfig {
  watchedFolder: string | null;
  filterRecent24h: boolean;
  preferredInterfaceAddress: string | null;
  preferredPort: number;
  localSendFingerprint: string;
  localSendPrivateKeyPem?: string;
  localSendCertPem?: string;
  localSendSelectedPeer: LocalSendPeer | null;
  localSendAutoPush: boolean;
  localSendPin: string;
  icloudShortcutUrl: string | null;
}

export interface DesktopBridgeApi {
  getState: () => Promise<DesktopAppState>;
  selectFolder: () => Promise<DesktopAppState>;
  setFolder: (folderPath: string) => Promise<DesktopAppState>;
  setFilterRecent24h: (recent24h: boolean) => Promise<DesktopAppState>;
  selectNetworkInterface: (address: string) => Promise<DesktopAppState>;
  refreshNetwork: () => Promise<DesktopAppState>;
  rotatePairingCredentials: () => Promise<DesktopAppState>;
  disconnectPairedDevice: () => Promise<DesktopAppState>;
  openWatchedFolderInExplorer: () => Promise<void>;
  scanLocalSendPeers: () => Promise<DesktopAppState>;
  addManualLocalSendPeer: (ip: string, port?: number) => Promise<DesktopAppState>;
  selectLocalSendPeer: (fingerprintOrNull: string | null) => Promise<DesktopAppState>;
  setLocalSendAutoPush: (enabled: boolean) => Promise<DesktopAppState>;
  setLocalSendPin: (pin: string) => Promise<DesktopAppState>;
  pushVideoViaLocalSend: (videoId: string) => Promise<DesktopAppState>;
  setIcloudShortcutUrl: (url: string) => Promise<DesktopAppState>;
  onStateChanged: (callback: (state: DesktopAppState) => void) => () => void;
}
