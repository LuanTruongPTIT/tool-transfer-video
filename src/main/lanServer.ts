import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import QRCode from 'qrcode';
import { FolderWatcher } from './folderWatcher';
import { AuthManager } from './authManager';
import { MkvRemuxer } from './mkvRemuxer';
import { LocalSendBridge } from './localSendBridge';
import {
  discoverLanInterfaces,
  isAllowedHostHeader,
  isPrivateRfc1918Ipv4,
  isSameIpv4Subnet,
  normalizeRemoteIpv4
} from './networkUtils';
import {
  MobileVideoItem,
  NetworkInterfaceOption,
  PairedDeviceInfo,
  PairingInfo
} from '../shared/types';

export interface LanServerOptions {
  rendererDistDir: string;
  mkvRemuxer?: MkvRemuxer;
  localSendBridge?: LocalSendBridge;
  getIcloudShortcutUrl?: () => string | null;
  allowLoopbackForTests?: boolean;
  abortGraceMs?: number;
}

interface ByteRange {
  start: number;
  end: number;
}

const SESSION_COOKIE_NAME = 'evd_session';
const STREAM_CHUNK_SIZE = 64 * 1024; // 64 KB chunks -> constant minimal RAM footprint
const APPLE_SHORTCUT_NAME = 'Ecom Video Drop';

function buildAppleShortcutRunUrl(urls: string[]): string {
  return `shortcuts://run-shortcut?name=${encodeURIComponent(
    APPLE_SHORTCUT_NAME
  )}&input=text&text=${encodeURIComponent(urls.join('\n'))}`;
}

export class LanServer extends EventEmitter {
  private readonly folderWatcher: FolderWatcher;
  private readonly authManager: AuthManager;
  private readonly mkvRemuxer: MkvRemuxer;
  private localSendBridge?: LocalSendBridge;
  private getIcloudShortcutUrl?: () => string | null;
  private readonly rendererDistDir: string;
  private readonly allowLoopbackForTests: boolean;
  private readonly abortGraceMs: number;

  private server: http.Server | null = null;
  private boundIp: string | null = null;
  private boundNetmask = '255.255.255.0';
  private boundPort = 0;
  private serverError: string | undefined;
  private qrDataUrl: string | null = null;

  private sseClients = new Set<http.ServerResponse>();
  private activeDownloadsPerVideo = new Map<string, number>();
  private abortTimersPerVideo = new Map<string, NodeJS.Timeout>();

  constructor(
    folderWatcher: FolderWatcher,
    authManager: AuthManager,
    options: LanServerOptions
  ) {
    super();
    this.folderWatcher = folderWatcher;
    this.authManager = authManager;
    this.mkvRemuxer = options.mkvRemuxer ?? new MkvRemuxer();
    this.localSendBridge = options.localSendBridge;
    this.getIcloudShortcutUrl = options.getIcloudShortcutUrl;
    this.rendererDistDir = options.rendererDistDir;
    this.allowLoopbackForTests = options.allowLoopbackForTests ?? false;
    this.abortGraceMs = options.abortGraceMs ?? 800;

    this.folderWatcher.on('change', () => {
      this.broadcastSseUpdate();
    });

    this.authManager.on('change', () => {
      void this.refreshQrCode().then(() => {
        this.emit('change');
      });
      if (!this.authManager.getPairedDevice()) {
        this.notifyAndDisconnectSseClients();
      } else {
        this.broadcastSseUpdate();
      }
    });
  }

  public getMkvRemuxer(): MkvRemuxer {
    return this.mkvRemuxer;
  }

  public setLocalSendBridge(bridge: LocalSendBridge): void {
    this.localSendBridge = bridge;
  }

  public async start(preferredAddress: string | null, preferredPort: number): Promise<void> {
    await this.stop();
    this.serverError = undefined;

    let targetIp: string | null = null;
    let targetNetmask = '255.255.255.0';

    if (this.allowLoopbackForTests && preferredAddress === '127.0.0.1') {
      targetIp = '127.0.0.1';
      targetNetmask = '255.0.0.0';
    } else {
      const interfaces = discoverLanInterfaces();
      if (interfaces.length === 0) {
        this.serverError =
          'Chưa phát hiện kết nối mạng Wi-Fi / LAN nội bộ. Hãy kết nối máy tính vào cùng mạng Wi-Fi với iPhone rồi bấm "Quét lại mạng".';
        this.emit('change');
        return;
      }

      const matched = preferredAddress
        ? interfaces.find((i) => i.address === preferredAddress)
        : undefined;
      const chosen: NetworkInterfaceOption = matched ?? interfaces[0];
      targetIp = chosen.address;
      targetNetmask = chosen.netmask;
    }

    const portsToTry: number[] = [];
    if (preferredPort === 0) {
      portsToTry.push(0);
    } else {
      for (let i = 0; i < 12; i++) {
        portsToTry.push(preferredPort + i);
      }
      portsToTry.push(0);
    }

    for (const candidatePort of portsToTry) {
      try {
        await this.listenOnce(targetIp, candidatePort);
        this.boundNetmask = targetNetmask;
        await this.refreshQrCode();
        this.emit('change');
        return;
      } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException)?.code;
        if (code === 'EADDRINUSE') {
          continue;
        }
        this.serverError = `Không thể khởi động máy chủ nội bộ trên ${targetIp}: ${
          err instanceof Error ? err.message : 'Lỗi không xác định'
        }`;
        this.emit('change');
        return;
      }
    }

    this.serverError = 'Không tìm được cổng mạng trống để khởi tạo kết nối nội bộ.';
    this.emit('change');
  }

  private listenOnce(ip: string, port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const srv = http.createServer((req, res) => {
        void this.handleRequest(req, res);
      });

      const onError = (err: Error) => {
        srv.removeListener('listening', onListening);
        reject(err);
      };

      const onListening = () => {
        srv.removeListener('error', onError);
        const addr = srv.address();
        this.server = srv;
        this.boundIp = ip;
        this.boundPort = typeof addr === 'object' && addr ? addr.port : port;
        resolve();
      };

      srv.once('error', onError);
      srv.once('listening', onListening);
      srv.listen(port, ip);
    });
  }

  public async stop(): Promise<void> {
    for (const timer of this.abortTimersPerVideo.values()) {
      clearTimeout(timer);
    }
    this.abortTimersPerVideo.clear();
    this.activeDownloadsPerVideo.clear();

    for (const client of this.sseClients) {
      try {
        client.end();
      } catch {
        // Ignore
      }
    }
    this.sseClients.clear();

    if (this.server) {
      const srv = this.server;
      this.server = null;
      await new Promise<void>((resolve) => {
        srv.close(() => resolve());
      });
    }
    await this.mkvRemuxer.cleanup();
    this.boundIp = null;
    this.boundPort = 0;
    this.qrDataUrl = null;
  }

  public getPairUrl(): string | null {
    if (!this.boundIp || !this.boundPort) return null;
    return `http://${this.boundIp}:${this.boundPort}/?k=${encodeURIComponent(
      this.authManager.getQrKey()
    )}`;
  }

  private async refreshQrCode(): Promise<void> {
    const url = this.getPairUrl();
    if (!url) {
      this.qrDataUrl = null;
      return;
    }
    try {
      this.qrDataUrl = await QRCode.toDataURL(url, {
        width: 280,
        margin: 2,
        errorCorrectionLevel: 'M',
        color: {
          dark: '#0f172a',
          light: '#ffffff'
        }
      });
    } catch {
      this.qrDataUrl = null;
    }
  }

  public getPairingInfo(): PairingInfo {
    const interfaces = discoverLanInterfaces();
    return {
      serverRunning: Boolean(this.server && this.boundIp && this.boundPort),
      serverError: this.serverError,
      lanIp: this.boundIp,
      port: this.boundPort,
      pairUrl: this.getPairUrl(),
      qrDataUrl: this.qrDataUrl,
      pinCode: this.authManager.getPinCode(),
      failedPinAttempts: this.authManager.getFailedPinAttempts(),
      maxPinAttempts: this.authManager.getMaxPinAttempts(),
      pairedDevice: this.authManager.getPairedDevice(),
      availableInterfaces: interfaces
    };
  }

  private applySecurityHeaders(res: http.ServerResponse): void {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
  }

  private sendJson(res: http.ServerResponse, statusCode: number, payload: unknown): void {
    this.applySecurityHeaders(res);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    const body = JSON.stringify(payload);
    res.statusCode = statusCode;
    res.end(body);
  }

  private parseCookies(cookieHeader: string | undefined): Record<string, string> {
    const out: Record<string, string> = {};
    if (!cookieHeader) return out;
    for (const part of cookieHeader.split(';')) {
      const idx = part.indexOf('=');
      if (idx <= 0) continue;
      const key = part.slice(0, idx).trim();
      const val = part.slice(idx + 1).trim();
      try {
        out[key] = decodeURIComponent(val);
      } catch {
        out[key] = val;
      }
    }
    return out;
  }

  private getAuthenticatedSession(req: http.IncomingMessage): PairedDeviceInfo | null {
    const cookies = this.parseCookies(req.headers.cookie);
    return this.authManager.verifySessionToken(cookies[SESSION_COOKIE_NAME]);
  }

  private isClientIpAllowed(remoteIp: string | null): boolean {
    if (!remoteIp || !this.boundIp) return false;
    if (this.allowLoopbackForTests && remoteIp === '127.0.0.1' && this.boundIp === '127.0.0.1') {
      return true;
    }
    if (!isPrivateRfc1918Ipv4(remoteIp)) {
      return false;
    }
    return isSameIpv4Subnet(remoteIp, this.boundIp, this.boundNetmask);
  }

  private isValidSameOriginPost(req: http.IncomingMessage): boolean {
    if (!this.boundIp || !this.boundPort) return false;
    const expectedOrigin = `http://${this.boundIp.toLowerCase()}:${this.boundPort}`;
    const origin = req.headers.origin?.trim().toLowerCase();
    // Require matching Origin when provided (all modern browsers including iOS Safari send Origin on POST)
    if (origin && origin !== expectedOrigin) {
      return false;
    }
    return true;
  }

  private readJsonBody(req: http.IncomingMessage, maxBytes = 8192): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let total = 0;

      req.on('data', (chunk: Buffer) => {
        total += chunk.length;
        if (total > maxBytes) {
          reject(new Error('Payload quá lớn.'));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });

      req.on('end', () => {
        try {
          const raw = Buffer.concat(chunks).toString('utf-8');
          if (!raw.trim()) {
            resolve({});
            return;
          }
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            resolve(parsed as Record<string, unknown>);
          } else {
            reject(new Error('Dữ liệu JSON không hợp lệ.'));
          }
        } catch {
          reject(new Error('Không thể đọc dữ liệu JSON.'));
        }
      });

      req.on('error', (err) => reject(err));
    });
  }

  public notifyExternalConfigChanged(): void {
    this.broadcastSseUpdate();
    this.emit('change');
  }

  private buildMobileVideoPayload(sessionId: string): {
    watchedFolderSelected: boolean;
    filterRecent24h: boolean;
    totalVideosInFolder: number;
    hiddenOlderCount: number;
    activeBrowserDownloadsCount: number;
    pendingPhotosCount: number;
    batchShortcutSaveUrl: string | null;
    quickPullHomeUrl: string;
    icloudShortcutUrl: string | null;
    videos: MobileVideoItem[];
  } {
    const snap = this.folderWatcher.getSnapshot();
    const origin =
      this.boundIp && this.boundPort ? `http://${this.boundIp}:${this.boundPort}` : '';

    const pendingShortcutUrls: string[] = [];

    const videos: MobileVideoItem[] = snap.videos.map((v) => {
      const previewTicket = this.authManager.createMediaTicket(sessionId, v.id, 'preview');
      const downloadTicket = this.authManager.createMediaTicket(sessionId, v.id, 'download');
      const baseDownloadUrl = `/api/videos/${encodeURIComponent(
        v.id
      )}/download?ticket=${encodeURIComponent(downloadTicket)}`;
      const fullShortcutVideoUrl = `${origin}${baseDownloadUrl}&via=shortcut`;
      const stem = path.basename(v.fileName, path.extname(v.fileName));
      const iosDownloadFileName = v.needsIosRemux ? `${stem}.mp4` : v.fileName;

      if (
        v.status !== 'saved_to_photos' &&
        v.status !== 'waiting_complete' &&
        v.status !== 'invalid'
      ) {
        pendingShortcutUrls.push(fullShortcutVideoUrl);
      }

      return {
        ...v,
        iosDownloadFileName,
        previewUrl: `/api/videos/${encodeURIComponent(v.id)}/preview?ticket=${encodeURIComponent(
          previewTicket
        )}`,
        downloadUrl: baseDownloadUrl,
        rawDownloadUrl: v.needsIosRemux ? `${baseDownloadUrl}&raw=1` : undefined,
        shortcutSaveUrl: buildAppleShortcutRunUrl([fullShortcutVideoUrl])
      };
    });

    const shortcutToken = this.authManager.createShortcutToken(sessionId);
    const quickPullHomeUrl = `${origin}/quick-pull?st=${encodeURIComponent(shortcutToken)}`;

    return {
      watchedFolderSelected: Boolean(this.folderWatcher.getWatchedFolder()),
      filterRecent24h: this.folderWatcher.getFilterRecent24h(),
      totalVideosInFolder: snap.totalVideosInFolder,
      hiddenOlderCount: snap.hiddenOlderCount,
      activeBrowserDownloadsCount: snap.activeBrowserDownloadsCount,
      pendingPhotosCount: pendingShortcutUrls.length,
      batchShortcutSaveUrl:
        pendingShortcutUrls.length > 0 ? buildAppleShortcutRunUrl(pendingShortcutUrls) : null,
      quickPullHomeUrl,
      icloudShortcutUrl: this.getIcloudShortcutUrl?.() ?? null,
      videos
    };
  }

  private broadcastSseUpdate(): void {
    const active = this.authManager.getPairedDevice();
    if (!active || this.sseClients.size === 0) return;

    const payload = JSON.stringify(this.buildMobileVideoPayload(active.sessionId));
    const frame = `event: update\ndata: ${payload}\n\n`;

    for (const client of Array.from(this.sseClients)) {
      try {
        client.write(frame);
      } catch {
        this.sseClients.delete(client);
      }
    }
  }

  private notifyAndDisconnectSseClients(): void {
    if (this.sseClients.size === 0) return;
    const frame = `event: revoked\ndata: {"reason":"paired_device_disconnected"}\n\n`;
    for (const client of Array.from(this.sseClients)) {
      try {
        client.write(frame);
        client.end();
      } catch {
        // Ignore
      }
    }
    this.sseClients.clear();
  }

  private async handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    if (!this.boundIp || !this.boundPort) {
      this.sendJson(res, 503, { error: 'Máy chủ chưa sẵn sàng.' });
      return;
    }

    const remoteIp = normalizeRemoteIpv4(req.socket.remoteAddress);
    if (!this.isClientIpAllowed(remoteIp)) {
      this.sendJson(res, 403, {
        error: 'Từ chối truy cập: Chỉ chấp nhận thiết bị trong cùng mạng Wi-Fi nội bộ.'
      });
      return;
    }

    if (!isAllowedHostHeader(req.headers.host, this.boundIp, this.boundPort)) {
      this.sendJson(res, 403, {
        error: 'Từ chối truy cập: Host header không hợp lệ (bảo vệ chống DNS Rebinding).'
      });
      return;
    }

    const parsedUrl = new URL(req.url ?? '/', `http://${this.boundIp}:${this.boundPort}`);
    const pathname = parsedUrl.pathname;
    const method = (req.method ?? 'GET').toUpperCase();

    // 1. API Routes
    if (pathname === '/api/session' && method === 'GET') {
      const session = this.getAuthenticatedSession(req);
      if (!session) {
        this.sendJson(res, 200, {
          authenticated: false,
          deviceAlreadyPairedOnPc: Boolean(this.authManager.getPairedDevice())
        });
        return;
      }
      this.sendJson(res, 200, {
        authenticated: true,
        device: session,
        ...this.buildMobileVideoPayload(session.sessionId)
      });
      return;
    }

    if (pathname === '/api/pair' && method === 'POST') {
      if (!this.isValidSameOriginPost(req)) {
        this.sendJson(res, 403, { error: 'Origin không hợp lệ.' });
        return;
      }
      try {
        const body = await this.readJsonBody(req);
        const qrKey = typeof body.qrKey === 'string' ? body.qrKey : undefined;
        const pinCode = typeof body.pinCode === 'string' ? body.pinCode : undefined;

        const result = this.authManager.attemptPairing({
          qrKey,
          pinCode,
          remoteIp: remoteIp!,
          userAgent: req.headers['user-agent']
        });

        if (!result.ok) {
          this.sendJson(res, result.statusCode, {
            ok: false,
            code: result.code,
            message: result.message,
            remainingAttempts: result.remainingAttempts
          });
          return;
        }

        const maxAge = this.authManager.getSessionTtlSeconds();
        res.setHeader(
          'Set-Cookie',
          `${SESSION_COOKIE_NAME}=${encodeURIComponent(
            result.sessionToken
          )}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}`
        );
        this.sendJson(res, 200, {
          ok: true,
          device: result.session,
          ...this.buildMobileVideoPayload(result.session.sessionId)
        });
      } catch (err: unknown) {
        this.sendJson(res, 400, {
          ok: false,
          message: err instanceof Error ? err.message : 'Yêu cầu không hợp lệ.'
        });
      }
      return;
    }

    if (pathname === '/api/videos' && method === 'GET') {
      const session = this.getAuthenticatedSession(req);
      if (!session) {
        this.sendJson(res, 401, { error: 'Phiên kết nối đã hết hạn hoặc bị ngắt từ máy tính.' });
        return;
      }
      this.sendJson(res, 200, this.buildMobileVideoPayload(session.sessionId));
      return;
    }

    if (pathname === '/api/events' && method === 'GET') {
      const session = this.getAuthenticatedSession(req);
      if (!session) {
        this.sendJson(res, 401, { error: 'Chưa xác thực ghép đôi.' });
        return;
      }

      this.applySecurityHeaders(res);
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive'
      });

      const initialPayload = JSON.stringify(this.buildMobileVideoPayload(session.sessionId));
      res.write(`event: update\ndata: ${initialPayload}\n\n`);

      this.sseClients.add(res);
      const keepAliveTimer = setInterval(() => {
        try {
          res.write(': ping\n\n');
        } catch {
          clearInterval(keepAliveTimer);
          this.sseClients.delete(res);
        }
      }, 20000);

      req.on('close', () => {
        clearInterval(keepAliveTimer);
        this.sseClients.delete(res);
      });
      return;
    }

    if (pathname === '/api/filter' && method === 'POST') {
      if (!this.isValidSameOriginPost(req)) {
        this.sendJson(res, 403, { error: 'Origin không hợp lệ.' });
        return;
      }
      const session = this.getAuthenticatedSession(req);
      if (!session) {
        this.sendJson(res, 401, { error: 'Phiên kết nối đã hết hạn.' });
        return;
      }
      try {
        const body = await this.readJsonBody(req);
        this.folderWatcher.setFilterRecent24h(Boolean(body.recent24h));
        this.sendJson(res, 200, {
          ok: true,
          ...this.buildMobileVideoPayload(session.sessionId)
        });
      } catch {
        this.sendJson(res, 400, { error: 'Yêu cầu không hợp lệ.' });
      }
      return;
    }

    const confirmMatch = pathname.match(/^\/api\/videos\/([a-f0-9]+)\/confirm-photos$/);
    if (confirmMatch && method === 'POST') {
      if (!this.isValidSameOriginPost(req)) {
        this.sendJson(res, 403, { error: 'Origin không hợp lệ.' });
        return;
      }
      const session = this.getAuthenticatedSession(req);
      if (!session) {
        this.sendJson(res, 401, { error: 'Phiên kết nối đã hết hạn.' });
        return;
      }
      const videoId = confirmMatch[1];
      const updated = this.folderWatcher.markSavedToPhotos(videoId);
      if (!updated) {
        this.sendJson(res, 404, { error: 'Không tìm thấy video hợp lệ để cập nhật trạng thái.' });
        return;
      }
      this.sendJson(res, 200, { ok: true });
      return;
    }

    const mediaMatch = pathname.match(/^\/api\/videos\/([a-f0-9]+)\/(preview|download)$/);
    if (mediaMatch && (method === 'GET' || method === 'HEAD')) {
      const videoId = mediaMatch[1];
      const mode = mediaMatch[2] as 'preview' | 'download';
      const ticket = parsedUrl.searchParams.get('ticket') ?? undefined;
      const forceRaw = parsedUrl.searchParams.get('raw') === '1';
      const viaShortcut = parsedUrl.searchParams.get('via') === 'shortcut';

      const session =
        this.authManager.verifyMediaTicket(ticket, videoId, mode) ??
        this.getAuthenticatedSession(req);

      if (!session) {
        this.sendJson(res, 401, {
          error: 'Vé tải video không hợp lệ hoặc phiên kết nối đã bị thu hồi.'
        });
        return;
      }

      await this.streamVideoFile(
        req,
        res,
        videoId,
        mode,
        method === 'HEAD',
        forceRaw,
        viaShortcut
      );
      return;
    }

    // LocalSend Protocol v2.1 Peer Registration & Info (allows instant discovery of iPhone LocalSend!)
    if (pathname === '/api/localsend/v2/info' && method === 'GET' && this.localSendBridge) {
      this.sendJson(res, 200, this.localSendBridge.getSenderInfoPayload());
      return;
    }

    if (pathname === '/api/localsend/v2/register' && method === 'POST' && this.localSendBridge) {
      try {
        const body = await this.readJsonBody(req);
        this.localSendBridge.registerDiscoveredPeer(body, remoteIp!);
        this.sendJson(res, 200, this.localSendBridge.getSenderInfoPayload());
      } catch {
        this.sendJson(res, 400, { error: 'Dữ liệu LocalSend register không hợp lệ.' });
      }
      return;
    }

    if (pathname.startsWith('/api/')) {
      this.sendJson(res, 404, { error: 'Không tìm thấy API.' });
      return;
    }

    // Apple Shortcuts Home Screen 1-Tap Quick Pull Launcher (/quick-pull?st=...)
    if (pathname === '/quick-pull' && (method === 'GET' || method === 'HEAD')) {
      const st = parsedUrl.searchParams.get('st') ?? undefined;
      const session =
        this.authManager.verifyShortcutToken(st) ?? this.getAuthenticatedSession(req);
      this.serveQuickPullHtml(res, session, method === 'HEAD');
      return;
    }

    // 2. Static Mobile Web Assets (/assets/* and SPA entry /)
    if (method !== 'GET' && method !== 'HEAD') {
      this.sendJson(res, 405, { error: 'Phương thức không được phép.' });
      return;
    }

    if (pathname.startsWith('/assets/')) {
      await this.serveStaticAsset(res, pathname, method === 'HEAD');
      return;
    }

    if (pathname === '/' || pathname === '/pair') {
      await this.serveMobileIndexHtml(res, method === 'HEAD');
      return;
    }

    // Redirect unknown non-API paths to root
    res.writeHead(302, { Location: '/' });
    res.end();
  }

  private parseByteRange(rangeHeader: string | undefined, fileSize: number): ByteRange | 'invalid' | null {
    if (!rangeHeader) return null;
    if (!rangeHeader.startsWith('bytes=')) return 'invalid';

    const spec = rangeHeader.slice(6).split(',')[0].trim();
    const dashIdx = spec.indexOf('-');
    if (dashIdx === -1) return 'invalid';

    const startPart = spec.slice(0, dashIdx).trim();
    const endPart = spec.slice(dashIdx + 1).trim();

    if (startPart === '') {
      // Suffix byte-range-spec: bytes=-N (used by QuickTime/iOS Safari for trailing moov boxes)
      const suffixLen = Number(endPart);
      if (!Number.isInteger(suffixLen) || suffixLen <= 0) return 'invalid';
      if (fileSize === 0) return 'invalid';
      const start = Math.max(0, fileSize - suffixLen);
      return { start, end: fileSize - 1 };
    }

    const start = Number(startPart);
    if (!Number.isInteger(start) || start < 0 || start >= fileSize) {
      return 'invalid';
    }

    if (endPart === '') {
      return { start, end: fileSize - 1 };
    }

    const requestedEnd = Number(endPart);
    if (!Number.isInteger(requestedEnd) || requestedEnd < start) {
      return 'invalid';
    }

    return {
      start,
      end: Math.min(requestedEnd, fileSize - 1)
    };
  }

  private buildContentDispositionAttachment(fileName: string): string {
    const asciiFallback = fileName
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^\x20-\x7E]/g, '_')
      .replace(/["\\]/g, '_');

    const encodedUtf8 = encodeURIComponent(fileName).replace(
      /['()*]/g,
      (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
    );

    return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodedUtf8}`;
  }

  private async streamVideoFile(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    videoId: string,
    mode: 'preview' | 'download',
    isHead: boolean,
    forceRaw = false,
    viaShortcut = false
  ): Promise<void> {
    const resolved = await this.folderWatcher.resolveDownloadableVideo(videoId);
    if (!resolved) {
      this.sendJson(res, 404, { error: 'Video không tồn tại hoặc chưa tải xong trên máy tính.' });
      return;
    }

    const { item, fullPath } = resolved;
    if (item.sizeBytes <= 0) {
      this.sendJson(res, 404, { error: 'File video rỗng.' });
      return;
    }

    let servePath = fullPath;
    let totalSize = item.sizeBytes;
    let serveMimeType: string = item.mimeType;
    let serveFileName = item.fileName;

    if (item.needsIosRemux && !forceRaw) {
      if (mode === 'download' && !isHead) {
        this.folderWatcher.markTransferProgress(videoId, 0, item.sizeBytes);
      }
      const remuxed = await this.mkvRemuxer.ensureIosMp4(
        fullPath,
        item.sizeBytes,
        item.modifiedAtMs
      );
      if (remuxed) {
        servePath = remuxed.mp4FilePath;
        totalSize = remuxed.sizeBytes;
        serveMimeType = 'video/mp4';
        const stem = path.basename(item.fileName, path.extname(item.fileName));
        serveFileName = `${stem}.mp4`;
      }
    }

    const parsedRange = this.parseByteRange(req.headers.range, totalSize);
    if (parsedRange === 'invalid') {
      this.applySecurityHeaders(res);
      res.writeHead(416, {
        'Content-Range': `bytes */${totalSize}`,
        'Accept-Ranges': 'bytes'
      });
      res.end();
      return;
    }

    const start = parsedRange ? parsedRange.start : 0;
    const end = parsedRange ? parsedRange.end : totalSize - 1;
    const chunkLength = end - start + 1;

    this.applySecurityHeaders(res);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Type', serveMimeType);
    res.setHeader('Content-Length', String(chunkLength));
    res.setHeader('Cache-Control', 'private, no-cache');

    if (mode === 'download') {
      res.setHeader(
        'Content-Disposition',
        this.buildContentDispositionAttachment(serveFileName)
      );
    } else {
      res.setHeader('Content-Disposition', 'inline');
    }

    if (parsedRange) {
      res.setHeader('Content-Range', `bytes ${start}-${end}/${totalSize}`);
      res.statusCode = 206;
    } else {
      res.statusCode = 200;
    }

    if (isHead) {
      res.end();
      return;
    }

    const isTrackedDownload = mode === 'download';
    if (isTrackedDownload) {
      const pendingTimer = this.abortTimersPerVideo.get(videoId);
      if (pendingTimer) {
        clearTimeout(pendingTimer);
        this.abortTimersPerVideo.delete(videoId);
      }
      const prevCount = this.activeDownloadsPerVideo.get(videoId) ?? 0;
      this.activeDownloadsPerVideo.set(videoId, prevCount + 1);
      this.folderWatcher.markTransferProgress(videoId, start, totalSize);
    }

    const readStream = fs.createReadStream(servePath, {
      start,
      end,
      highWaterMark: STREAM_CHUNK_SIZE
    });

    let streamedBytes = 0;
    let lastProgressReportAt = 0;
    let settled = false;

    const finalizeDownloadTracking = (completedSuccessfully: boolean, errReason?: string) => {
      if (!isTrackedDownload || settled) return;
      settled = true;

      const remaining = Math.max(0, (this.activeDownloadsPerVideo.get(videoId) ?? 1) - 1);
      if (remaining === 0) {
        this.activeDownloadsPerVideo.delete(videoId);
      } else {
        this.activeDownloadsPerVideo.set(videoId, remaining);
      }

      if (completedSuccessfully && end === totalSize - 1 && start + streamedBytes >= totalSize) {
        const timer = this.abortTimersPerVideo.get(videoId);
        if (timer) {
          clearTimeout(timer);
          this.abortTimersPerVideo.delete(videoId);
        }
        if (viaShortcut) {
          this.folderWatcher.markSavedToPhotos(videoId);
        } else {
          this.folderWatcher.markDownloadedToSafari(videoId, item.sizeBytes);
        }
        return;
      }

      if (!completedSuccessfully && remaining === 0) {
        // Grace window handles iOS Safari's initial header probe handoff to Download Manager
        const timer = setTimeout(() => {
          this.abortTimersPerVideo.delete(videoId);
          if ((this.activeDownloadsPerVideo.get(videoId) ?? 0) === 0) {
            this.folderWatcher.markTransferError(
              videoId,
              errReason ??
                'Truyền file bị ngắt giữa chừng trên Wi-Fi. Vui lòng giữ sáng màn hình Safari và bấm Thử lại.'
            );
          }
        }, this.abortGraceMs);
        this.abortTimersPerVideo.set(videoId, timer);
      }
    };

    readStream.on('data', (chunk: Buffer | string) => {
      const len = typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length;
      streamedBytes += len;

      const canContinue = res.write(chunk);
      if (!canContinue) {
        readStream.pause();
        res.once('drain', () => {
          readStream.resume();
        });
      }

      if (isTrackedDownload) {
        const now = Date.now();
        if (now - lastProgressReportAt >= 120) {
          lastProgressReportAt = now;
          this.folderWatcher.markTransferProgress(videoId, start + streamedBytes, totalSize);
        }
      }
    });

    readStream.on('end', () => {
      res.end(() => {
        const allBytesSent = streamedBytes === chunkLength && !res.destroyed;
        finalizeDownloadTracking(allBytesSent);
      });
    });

    readStream.on('error', () => {
      if (!res.headersSent) {
        this.sendJson(res, 500, { error: 'Lỗi đọc file video trên máy tính.' });
      } else {
        res.destroy();
      }
      finalizeDownloadTracking(false, 'Không thể đọc tiếp file video từ ổ cứng máy tính.');
    });

    res.on('close', () => {
      const completedAll = res.writableFinished && streamedBytes === chunkLength;
      if (!completedAll) {
        readStream.destroy();
        finalizeDownloadTracking(false);
      } else {
        finalizeDownloadTracking(true);
      }
    });
  }

  private escapeHtml(raw: string): string {
    return raw
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  private serveQuickPullHtml(
    res: http.ServerResponse,
    session: PairedDeviceInfo | null,
    isHead: boolean
  ): void {
    const svgIcon = encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 180 180"><rect width="180" height="180" rx="40" fill="#059669"/><path d="M90 36v72m0 0l-28-28m28 28l28-28M44 134h92" stroke="#fff" stroke-width="16" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>`
    );

    let bodyContent = '';
    let autoRunScript = '';

    if (!session) {
      bodyContent = `
        <div class="card">
          <div class="badge warn">Phiên kết nối đã hết hạn</div>
          <h1>Cần ghép đôi lại với máy tính</h1>
          <p>Mã kết nối trên máy tính đã thay đổi hoặc hết hạn ca làm việc. Hãy mở <b>Ecom Video Drop</b> trên máy tính và quét lại mã QR.</p>
          <a class="btn primary" href="/">Về trang ghép đôi</a>
        </div>`;
    } else {
      const payload = this.buildMobileVideoPayload(session.sessionId);
      if (payload.pendingPhotosCount > 0 && payload.batchShortcutSaveUrl) {
        const safeShortcutHref = this.escapeHtml(payload.batchShortcutSaveUrl);
        bodyContent = `
          <div class="card">
            <div class="badge ok">Sẵn sàng hút 1 chạm</div>
            <h1>Có ${payload.pendingPhotosCount} video mới</h1>
            <p>Đang tự động gọi Phím tắt <b>Ecom Video Drop</b> để tải và lưu thẳng toàn bộ video mới vào ứng dụng <b>Ảnh (Photos)</b>...</p>
            <a class="btn primary" href="${safeShortcutHref}">Hút ngay ${payload.pendingPhotosCount} video vào Ảnh</a>
            <a class="btn secondary" href="/">Mở danh sách video đầy đủ</a>
          </div>`;
        autoRunScript = `<script>setTimeout(function(){ window.location.href = ${JSON.stringify(
          payload.batchShortcutSaveUrl
        )}; }, 350);</script>`;
      } else {
        bodyContent = `
          <div class="card">
            <div class="badge ok">Đã đồng bộ đầy đủ</div>
            <h1>Không còn video chờ lưu</h1>
            <p>Tất cả video sẵn sàng trong thư mục theo dõi đều đã nằm trong ứng dụng <b>Ảnh</b> trên iPhone của bạn.</p>
            <a class="btn primary" href="${this.escapeHtml(
              payload.quickPullHomeUrl
            )}">Kiểm tra lại video mới</a>
            <a class="btn secondary" href="/">Mở danh sách video đầy đủ</a>
          </div>`;
      }
    }

    const html = `<!doctype html>
<html lang="vi">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover" />
  <meta name="apple-mobile-web-app-title" content="Hút Video" />
  <link rel="apple-touch-icon" href="data:image/svg+xml,${svgIcon}" />
  <title>Hút Video Ecom</title>
  <style>
    * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif; }
    body { margin: 0; min-height: 100vh; background: #0f172a; color: #f8fafc; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 20px; }
    .card { width: 100%; max-width: 400px; background: #1e293b; border: 1px solid #334155; border-radius: 24px; padding: 24px; text-align: center; box-shadow: 0 20px 40px rgba(0,0,0,0.35); }
    .badge { display: inline-block; font-size: 12px; font-weight: 700; padding: 5px 12px; border-radius: 999px; margin-bottom: 12px; }
    .badge.ok { background: rgba(16,185,129,0.18); color: #34d399; border: 1px solid rgba(52,211,153,0.35); }
    .badge.warn { background: rgba(245,158,11,0.18); color: #fbbf24; border: 1px solid rgba(251,191,36,0.35); }
    h1 { font-size: 22px; margin: 0 0 10px; }
    p { font-size: 14px; line-height: 1.55; color: #cbd5e1; margin: 0 0 20px; }
    .btn { display: block; width: 100%; padding: 14px 16px; border-radius: 14px; font-size: 15px; font-weight: 700; text-decoration: none; margin-bottom: 10px; }
    .btn.primary { background: #059669; color: #ffffff; }
    .btn.secondary { background: #334155; color: #e2e8f0; font-weight: 600; margin-bottom: 0; }
    .tip { width: 100%; max-width: 400px; margin-top: 14px; padding: 14px 16px; border-radius: 16px; background: rgba(30,41,59,0.7); border: 1px solid #334155; font-size: 12px; line-height: 1.5; color: #94a3b8; }
    .tip b { color: #e2e8f0; }
  </style>
</head>
<body>
  ${bodyContent}
  <div class="tip">
    <b>Mẹo gắn ra Màn hình chính iPhone:</b> Bấm nút <b>Chia sẻ</b> ở thanh dưới Safari &rarr; chọn <b>Thêm vào MH chính (Add to Home Screen)</b>. Lần sau chỉ cần chạm icon <b>Hút Video</b> ngoài màn hình để tự lưu toàn bộ video mới vào Ảnh!
  </div>
  ${autoRunScript}
</body>
</html>`;

    const buf = Buffer.from(html, 'utf-8');
    this.applySecurityHeaders(res);
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': String(buf.length),
      'Cache-Control': 'no-store'
    });
    if (isHead) {
      res.end();
      return;
    }
    res.end(buf);
  }

  private async serveMobileIndexHtml(res: http.ServerResponse, isHead: boolean): Promise<void> {
    const htmlPath = path.join(this.rendererDistDir, 'mobile', 'index.html');
    try {
      const stat = await fs.promises.stat(htmlPath);
      this.applySecurityHeaders(res);
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': String(stat.size),
        'Cache-Control': 'no-cache'
      });
      if (isHead) {
        res.end();
        return;
      }
      fs.createReadStream(htmlPath).pipe(res);
    } catch {
      this.sendJson(res, 500, {
        error: 'Chưa build giao diện Mobile Web. Hãy chạy lệnh npm run build.'
      });
    }
  }

  private async serveStaticAsset(
    res: http.ServerResponse,
    pathname: string,
    isHead: boolean
  ): Promise<void> {
    const assetsRoot = path.resolve(this.rendererDistDir, 'assets');
    const relativeAsset = pathname.slice('/assets/'.length);
    const resolvedAsset = path.resolve(assetsRoot, relativeAsset);

    if (!resolvedAsset.startsWith(`${assetsRoot}${path.sep}`)) {
      this.sendJson(res, 403, { error: 'Đường dẫn tài nguyên không hợp lệ.' });
      return;
    }

    try {
      const stat = await fs.promises.stat(resolvedAsset);
      if (!stat.isFile()) {
        this.sendJson(res, 404, { error: 'Không tìm thấy tài nguyên.' });
        return;
      }

      const ext = path.extname(resolvedAsset).toLowerCase();
      const mimeMap: Record<string, string> = {
        '.js': 'application/javascript; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
        '.svg': 'image/svg+xml',
        '.png': 'image/png',
        '.ico': 'image/x-icon'
      };

      this.applySecurityHeaders(res);
      res.writeHead(200, {
        'Content-Type': mimeMap[ext] ?? 'application/octet-stream',
        'Content-Length': String(stat.size),
        'Cache-Control': 'public, max-age=300'
      });

      if (isHead) {
        res.end();
        return;
      }

      fs.createReadStream(resolvedAsset).pipe(res);
    } catch {
      this.sendJson(res, 404, { error: 'Không tìm thấy tài nguyên.' });
    }
  }
}
