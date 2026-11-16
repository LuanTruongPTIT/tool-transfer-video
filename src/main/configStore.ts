import fs from 'node:fs';
import path from 'node:path';
import { AppConfig, LocalSendPeer } from '../shared/types';
import {
  generateLocalSendTlsIdentity,
  isValidLocalSendTlsIdentity
} from './localSendCert';

export class ConfigStore {
  private readonly filePath: string;
  private current: AppConfig;

  constructor(storageDir: string) {
    this.filePath = path.join(storageDir, 'settings.json');
    this.current = this.load();
  }

  private load(): AppConfig {
    try {
      if (!fs.existsSync(this.filePath)) {
        const identity = generateLocalSendTlsIdentity();
        const initial: AppConfig = {
          watchedFolder: null,
          filterRecent24h: true,
          preferredInterfaceAddress: null,
          preferredPort: 45780,
          localSendFingerprint: identity.fingerprint,
          localSendPrivateKeyPem: identity.privateKeyPem,
          localSendCertPem: identity.certificatePem,
          localSendSelectedPeer: null,
          localSendAutoPush: false,
          localSendPin: '',
          icloudShortcutUrl: null
        };
        this.persist(initial);
        return initial;
      }

      const raw = fs.readFileSync(this.filePath, 'utf-8');
      const parsed = JSON.parse(raw) as Partial<AppConfig>;

      const hasValidCert = isValidLocalSendTlsIdentity(
        parsed.localSendPrivateKeyPem,
        parsed.localSendCertPem,
        parsed.localSendFingerprint
      );

      const identity = hasValidCert
        ? {
            privateKeyPem: parsed.localSendPrivateKeyPem!,
            certificatePem: parsed.localSendCertPem!,
            fingerprint: parsed.localSendFingerprint!.toUpperCase()
          }
        : generateLocalSendTlsIdentity();

      const selectedPeer = this.sanitizePeer(parsed.localSendSelectedPeer);

      const loaded: AppConfig = {
        watchedFolder:
          typeof parsed.watchedFolder === 'string' && parsed.watchedFolder.trim().length > 0
            ? parsed.watchedFolder
            : null,
        filterRecent24h:
          typeof parsed.filterRecent24h === 'boolean' ? parsed.filterRecent24h : true,
        preferredInterfaceAddress:
          typeof parsed.preferredInterfaceAddress === 'string'
            ? parsed.preferredInterfaceAddress
            : null,
        preferredPort:
          typeof parsed.preferredPort === 'number' &&
          parsed.preferredPort >= 1024 &&
          parsed.preferredPort <= 65535
            ? parsed.preferredPort
            : 45780,
        localSendFingerprint: identity.fingerprint,
        localSendPrivateKeyPem: identity.privateKeyPem,
        localSendCertPem: identity.certificatePem,
        localSendSelectedPeer: selectedPeer,
        localSendAutoPush: Boolean(parsed.localSendAutoPush),
        localSendPin: typeof parsed.localSendPin === 'string' ? parsed.localSendPin : '',
        icloudShortcutUrl:
          typeof parsed.icloudShortcutUrl === 'string' &&
          parsed.icloudShortcutUrl.trim().startsWith('https://www.icloud.com/shortcuts/')
            ? parsed.icloudShortcutUrl.trim()
            : null
      };

      if (!hasValidCert) {
        this.persist(loaded);
      }
      return loaded;
    } catch {
      const identity = generateLocalSendTlsIdentity();
      return {
        watchedFolder: null,
        filterRecent24h: true,
        preferredInterfaceAddress: null,
        preferredPort: 45780,
        localSendFingerprint: identity.fingerprint,
        localSendPrivateKeyPem: identity.privateKeyPem,
        localSendCertPem: identity.certificatePem,
        localSendSelectedPeer: null,
        localSendAutoPush: false,
        localSendPin: '',
        icloudShortcutUrl: null
      };
    }
  }

  private sanitizePeer(raw: unknown): LocalSendPeer | null {
    if (!raw || typeof raw !== 'object') return null;
    const p = raw as Partial<LocalSendPeer>;
    if (
      typeof p.fingerprint !== 'string' ||
      typeof p.alias !== 'string' ||
      typeof p.ip !== 'string' ||
      typeof p.port !== 'number'
    ) {
      return null;
    }
    return {
      fingerprint: p.fingerprint,
      alias: p.alias,
      deviceModel: typeof p.deviceModel === 'string' ? p.deviceModel : 'iPhone',
      deviceType: typeof p.deviceType === 'string' ? p.deviceType : 'mobile',
      ip: p.ip,
      port: p.port,
      protocol: p.protocol === 'http' ? 'http' : 'https',
      lastSeenAtMs: typeof p.lastSeenAtMs === 'number' ? p.lastSeenAtMs : Date.now()
    };
  }

  private persist(cfg: AppConfig): void {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const tmpPath = `${this.filePath}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(cfg, null, 2), 'utf-8');
      fs.renameSync(tmpPath, this.filePath);
    } catch {
      // Non-fatal; keep in-memory config
    }
  }

  public get(): AppConfig {
    return { ...this.current };
  }

  public update(patch: Partial<AppConfig>): AppConfig {
    this.current = {
      ...this.current,
      ...patch
    };
    this.persist(this.current);
    return this.get();
  }
}
