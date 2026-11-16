import dgram from 'node:dgram';
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { FolderWatcher } from './folderWatcher';
import { MkvRemuxer } from './mkvRemuxer';
import { LocalSendPeer, LocalSendState } from '../shared/types';
import { isPrivateRfc1918Ipv4 } from './networkUtils';
import {
  generateLocalSendTlsIdentity,
  isValidLocalSendTlsIdentity,
  LocalSendTlsIdentity
} from './localSendCert';

const MULTICAST_ADDR = '224.0.0.167';
const LOCALSEND_PORT = 53317;
const STREAM_CHUNK_SIZE = 64 * 1024;

export interface LocalSendBridgeOptions {
  fingerprint?: string;
  privateKeyPem?: string;
  certificatePem?: string;
  alias?: string;
  initialSelectedPeer?: LocalSendPeer | null;
  initialAutoPush?: boolean;
  initialPin?: string;
  allowLoopbackForTests?: boolean;
}

interface LocalSendDeviceDto {
  alias?: string;
  version?: string;
  deviceModel?: string;
  deviceType?: string;
  fingerprint?: string;
  port?: number;
  protocol?: 'http' | 'https';
  download?: boolean;
  announce?: boolean;
}

export class LocalSendBridge extends EventEmitter {
  private readonly folderWatcher: FolderWatcher;
  private readonly mkvRemuxer: MkvRemuxer;
  private readonly tlsIdentity: LocalSendTlsIdentity;
  private readonly fingerprint: string;
  private readonly senderAlias: string;
  private readonly allowLoopbackForTests: boolean;
  private readonly insecureTlsAgent: https.Agent;

  private udpSocket: dgram.Socket | null = null;
  private lanIp: string | null = null;
  private registerCallbackPort = 0;

  private peersByFingerprint = new Map<string, LocalSendPeer>();
  private selectedPeer: LocalSendPeer | null = null;
  private autoPushNewVideos = false;
  private autoPushSinceMs = Date.now();
  private pin = '';

  private scanning = false;
  private activePushVideoId: string | null = null;
  private lastPushMessage: string | null = null;
  private lastPushError: string | null = null;

  private pushQueue: string[] = [];
  private processingQueue = false;
  private autoQueuedVideoIds = new Set<string>();

  constructor(
    folderWatcher: FolderWatcher,
    mkvRemuxer: MkvRemuxer,
    options: LocalSendBridgeOptions
  ) {
    super();
    this.folderWatcher = folderWatcher;
    this.mkvRemuxer = mkvRemuxer;

    if (
      isValidLocalSendTlsIdentity(
        options.privateKeyPem,
        options.certificatePem,
        options.fingerprint
      )
    ) {
      this.tlsIdentity = {
        privateKeyPem: options.privateKeyPem!,
        certificatePem: options.certificatePem!,
        fingerprint: options.fingerprint!.toUpperCase()
      };
    } else {
      this.tlsIdentity = generateLocalSendTlsIdentity();
    }

    this.fingerprint = this.tlsIdentity.fingerprint;
    const hostLabel = os.hostname().split('.')[0] || 'PC';
    this.senderAlias = options.alias ?? `Ecom Video Drop (${hostLabel})`;
    this.allowLoopbackForTests = options.allowLoopbackForTests ?? false;

    // LocalSend v2.1+ enforces Mutual TLS (mTLS): client MUST present a valid self-signed RSA-2048 X.509 certificate!
    this.insecureTlsAgent = new https.Agent({
      key: this.tlsIdentity.privateKeyPem,
      cert: this.tlsIdentity.certificatePem,
      rejectUnauthorized: false,
      checkServerIdentity: () => undefined,
      keepAlive: false
    });

    if (options.initialSelectedPeer) {
      this.selectedPeer = { ...options.initialSelectedPeer };
      this.peersByFingerprint.set(this.selectedPeer.fingerprint, { ...this.selectedPeer });
    }
    this.autoPushNewVideos = Boolean(options.initialAutoPush);
    this.autoPushSinceMs = Date.now();
    this.pin = options.initialPin ?? '';

    this.folderWatcher.on('change', () => {
      this.checkAndEnqueueAutoPush();
    });
  }

  public getSenderInfoPayload() {
    return {
      alias: this.senderAlias,
      version: '2.1',
      deviceModel: process.platform === 'win32' ? 'Windows PC' : 'Desktop',
      deviceType: 'desktop',
      fingerprint: this.fingerprint,
      port: this.registerCallbackPort || LOCALSEND_PORT,
      protocol: 'http' as const,
      download: false
    };
  }

  public getState(): LocalSendState {
    const peers = Array.from(this.peersByFingerprint.values()).sort((a, b) => {
      const aMobile = a.deviceType === 'mobile' || /iphone|ipad|ios/i.test(a.deviceModel);
      const bMobile = b.deviceType === 'mobile' || /iphone|ipad|ios/i.test(b.deviceModel);
      if (aMobile !== bMobile) return aMobile ? -1 : 1;
      return b.lastSeenAtMs - a.lastSeenAtMs;
    });

    return {
      senderAlias: this.senderAlias,
      senderFingerprintShort: this.fingerprint.slice(0, 8).toUpperCase(),
      discoveredPeers: peers,
      selectedPeer: this.selectedPeer ? { ...this.selectedPeer } : null,
      autoPushNewVideos: this.autoPushNewVideos,
      pin: this.pin,
      scanning: this.scanning,
      activePushVideoId: this.activePushVideoId,
      lastPushMessage: this.lastPushMessage,
      lastPushError: this.lastPushError
    };
  }

  public async startDiscovery(lanIp: string | null, callbackPort: number): Promise<void> {
    this.stopDiscovery();
    this.lanIp = lanIp;
    this.registerCallbackPort = callbackPort;

    if (!lanIp || (!isPrivateRfc1918Ipv4(lanIp) && !this.allowLoopbackForTests)) {
      return;
    }

    try {
      const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      sock.on('error', () => {
        // Ignore UDP bind conflict if another app holds exclusive UDP socket; HTTP scan still works
      });

      sock.on('message', (msg, rinfo) => {
        if (!isPrivateRfc1918Ipv4(rinfo.address)) return;
        try {
          const parsed = JSON.parse(msg.toString('utf-8')) as LocalSendDeviceDto;
          if (!parsed || parsed.fingerprint === this.fingerprint) return;
          this.registerDiscoveredPeer(parsed, rinfo.address);
          if (parsed.announce) {
            this.sendMulticastAnnounce(false);
          }
        } catch {
          // Ignore non-JSON UDP packets
        }
      });

      await new Promise<void>((resolve) => {
        sock.bind(LOCALSEND_PORT, () => {
          try {
            sock.setBroadcast(true);
            sock.setMulticastTTL(64);
            if (isPrivateRfc1918Ipv4(lanIp)) {
              sock.addMembership(MULTICAST_ADDR, lanIp);
            }
          } catch {
            // Best-effort membership join
          }
          resolve();
        });
      });

      this.udpSocket = sock;
      this.sendMulticastAnnounce(true);
    } catch {
      // Non-fatal: active subnet scanning remains available
    }
  }

  public stopDiscovery(): void {
    if (this.udpSocket) {
      try {
        this.udpSocket.close();
      } catch {
        // Ignore
      }
      this.udpSocket = null;
    }
  }

  private sendMulticastAnnounce(announce: boolean): void {
    if (!this.udpSocket) return;
    const payload = JSON.stringify({
      ...this.getSenderInfoPayload(),
      announce
    });
    const buf = Buffer.from(payload, 'utf-8');
    try {
      this.udpSocket.send(buf, 0, buf.length, LOCALSEND_PORT, MULTICAST_ADDR);
    } catch {
      // Ignore transient network error
    }
  }

  public registerDiscoveredPeer(dto: LocalSendDeviceDto, remoteIp: string): LocalSendPeer | null {
    if (!dto.fingerprint || dto.fingerprint === this.fingerprint) return null;
    if (!dto.alias) return null;

    const peer: LocalSendPeer = {
      fingerprint: dto.fingerprint,
      alias: dto.alias,
      deviceModel: dto.deviceModel || 'Thiết bị LocalSend',
      deviceType: dto.deviceType || 'mobile',
      ip: remoteIp,
      port: typeof dto.port === 'number' && dto.port > 0 ? dto.port : LOCALSEND_PORT,
      protocol: dto.protocol === 'http' ? 'http' : 'https',
      lastSeenAtMs: Date.now()
    };

    this.peersByFingerprint.set(peer.fingerprint, peer);

    // Keep selectedPeer IP updated if the same iPhone changed DHCP address!
    if (this.selectedPeer && this.selectedPeer.fingerprint === peer.fingerprint) {
      this.selectedPeer = { ...peer };
    } else if (!this.selectedPeer && (peer.deviceType === 'mobile' || /iphone|ipad/i.test(peer.deviceModel))) {
      // Auto-select first discovered iPhone if none was chosen yet
      this.selectedPeer = { ...peer };
    }

    this.emit('change');
    return peer;
  }

  public async probeSingleHost(
    ip: string,
    port = LOCALSEND_PORT,
    timeoutMs = 750
  ): Promise<LocalSendPeer | null> {
    if (!isPrivateRfc1918Ipv4(ip) && !(this.allowLoopbackForTests && ip === '127.0.0.1')) {
      return null;
    }

    for (const protocol of ['https', 'http'] as const) {
      const dto = await this.fetchPeerInfo(protocol, ip, port, timeoutMs);
      if (dto && dto.fingerprint && dto.fingerprint !== this.fingerprint) {
        return this.registerDiscoveredPeer({ ...dto, port, protocol }, ip);
      }
    }
    return null;
  }

  public async connectManualIp(
    rawInput: string,
    explicitPort?: number
  ): Promise<LocalSendPeer | null> {
    let cleaned = rawInput.trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
    let port = explicitPort ?? LOCALSEND_PORT;

    if (cleaned.includes(':')) {
      const [hostPart, portPart] = cleaned.split(':');
      cleaned = hostPart.trim();
      const parsedPort = Number(portPart);
      if (Number.isInteger(parsedPort) && parsedPort > 0 && parsedPort <= 65535) {
        port = parsedPort;
      }
    }

    if (!isPrivateRfc1918Ipv4(cleaned) && !(this.allowLoopbackForTests && cleaned === '127.0.0.1')) {
      this.lastPushError =
        'Địa chỉ IP không hợp lệ hoặc không thuộc mạng Wi-Fi nội bộ (ví dụ hợp lệ: 192.168.1.25).';
      this.emit('change');
      return null;
    }

    this.lastPushError = null;
    const peer = await this.probeSingleHost(cleaned, port, 2200);
    if (!peer) {
      this.lastPushError = `Không tìm thấy LocalSend tại ${cleaned}:${port}. Hãy mở sẵn ứng dụng LocalSend trên màn hình iPhone và kiểm tra cùng mạng Wi-Fi.`;
      this.emit('change');
      return null;
    }

    this.selectPeer(peer.fingerprint);
    this.lastPushMessage = `Đã kết nối với ${peer.alias} (${peer.ip})!`;
    this.emit('change');
    return peer;
  }

  private getHttpsClientTlsOptions(): https.RequestOptions {
    return {
      agent: this.insecureTlsAgent,
      key: this.tlsIdentity.privateKeyPem,
      cert: this.tlsIdentity.certificatePem,
      rejectUnauthorized: false,
      checkServerIdentity: () => undefined
    };
  }

  private formatConnectionError(err: unknown, peer: LocalSendPeer): string {
    const code = (err as NodeJS.ErrnoException)?.code ?? '';
    const rawMsg = err instanceof Error ? err.message : String(err);

    if (code === 'ECONNREFUSED') {
      return `Hãy mở sáng màn hình app LocalSend trên ${peer.alias} rồi thử lại.`;
    }
    if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH' || code === 'EACCES') {
      if (process.platform === 'darwin') {
        return `Cần bật quyền Mạng cục bộ (Local Network) cho ứng dụng trong Cài đặt macOS.`;
      }
      return `Không kết nối được tới ${peer.ip} — kiểm tra cùng mạng Wi-Fi.`;
    }
    return `Mất kết nối tới ${peer.alias} (${code || rawMsg}).`;
  }

  private fetchPeerInfo(
    protocol: 'http' | 'https',
    ip: string,
    port: number,
    timeoutMs: number
  ): Promise<LocalSendDeviceDto | null> {
    return new Promise((resolve) => {
      const mod = protocol === 'https' ? https : http;
      const req = mod.request(
        {
          hostname: ip,
          port,
          path: '/api/localsend/v2/info',
          method: 'GET',
          timeout: timeoutMs,
          ...(protocol === 'https' ? this.getHttpsClientTlsOptions() : {})
        },
        (res) => {
          if (res.statusCode !== 200) {
            res.resume();
            resolve(null);
            return;
          }
          const chunks: Buffer[] = [];
          let total = 0;
          res.on('data', (c: Buffer) => {
            total += c.length;
            if (total <= 16384) chunks.push(c);
          });
          res.on('end', () => {
            try {
              const parsed = JSON.parse(
                Buffer.concat(chunks).toString('utf-8')
              ) as LocalSendDeviceDto;
              resolve(parsed);
            } catch {
              resolve(null);
            }
          });
        }
      );

      req.on('timeout', () => {
        req.destroy();
        resolve(null);
      });
      req.on('error', () => {
        resolve(null);
      });
      req.end();
    });
  }

  public async scanPeers(priorityIps: string[] = []): Promise<void> {
    if (this.scanning) return;
    this.scanning = true;
    this.lastPushError = null;
    this.emit('change');

    try {
      this.sendMulticastAnnounce(true);

      const uniquePriority = Array.from(
        new Set(
          [
            ...priorityIps,
            this.selectedPeer?.ip ?? ''
          ].filter((ip) => ip && isPrivateRfc1918Ipv4(ip))
        )
      );

      for (const ip of uniquePriority) {
        await this.probeSingleHost(ip, LOCALSEND_PORT, 900);
      }

      // Fast /24 subnet sweep fallback when multicast is blocked on office routers
      if (this.lanIp && isPrivateRfc1918Ipv4(this.lanIp)) {
        const octets = this.lanIp.split('.');
        const prefix = `${octets[0]}.${octets[1]}.${octets[2]}`;
        const candidates: string[] = [];
        for (let host = 1; host <= 254; host++) {
          const candidate = `${prefix}.${host}`;
          if (candidate !== this.lanIp && !uniquePriority.includes(candidate)) {
            candidates.push(candidate);
          }
        }

        const concurrency = 32;
        let index = 0;
        const workers = Array.from({ length: concurrency }, async () => {
          while (index < candidates.length) {
            const currentIp = candidates[index++];
            await this.probeSingleHost(currentIp, LOCALSEND_PORT, 550);
          }
        });
        await Promise.all(workers);
      }
    } finally {
      this.scanning = false;
      this.emit('change');
    }
  }

  public selectPeer(fingerprintOrNull: string | null): LocalSendPeer | null {
    if (!fingerprintOrNull) {
      this.selectedPeer = null;
      this.emit('change');
      return null;
    }
    const found = this.peersByFingerprint.get(fingerprintOrNull);
    if (found) {
      this.selectedPeer = { ...found };
      this.lastPushError = null;
      this.emit('change');
    }
    return this.selectedPeer;
  }

  public setAutoPush(enabled: boolean): void {
    this.autoPushNewVideos = enabled;
    // Reset watermark to NOW so toggling ON only auto-pushes newly arriving videos
    this.autoPushSinceMs = Date.now();
    this.emit('change');
  }

  public setPin(pin: string): void {
    this.pin = pin.trim();
    this.emit('change');
  }

  private checkAndEnqueueAutoPush(): void {
    if (!this.autoPushNewVideos || !this.selectedPeer) return;

    const snap = this.folderWatcher.getSnapshot();
    for (const v of snap.videos) {
      if (
        v.status === 'ready' &&
        v.detectedAtMs >= this.autoPushSinceMs &&
        !this.autoQueuedVideoIds.has(v.id)
      ) {
        this.autoQueuedVideoIds.add(v.id);
        this.enqueueVideoPush(v.id);
      }
    }
  }

  public enqueueVideoPush(videoId: string): void {
    if (!this.pushQueue.includes(videoId) && this.activePushVideoId !== videoId) {
      this.pushQueue.push(videoId);
    }
    void this.drainPushQueue();
  }

  private async drainPushQueue(): Promise<void> {
    if (this.processingQueue) return;
    this.processingQueue = true;

    try {
      while (this.pushQueue.length > 0) {
        const nextId = this.pushQueue.shift()!;
        await this.pushSingleVideoNow(nextId);
      }
    } finally {
      this.processingQueue = false;
    }
  }

  public async pushSingleVideoNow(videoId: string): Promise<boolean> {
    const peer = this.selectedPeer;
    if (!peer) {
      this.lastPushError =
        'Chưa chọn iPhone nhận (LocalSend). Hãy mở app LocalSend trên iPhone và bấm "Quét tìm iPhone".';
      this.emit('change');
      return false;
    }

    const resolved = await this.folderWatcher.resolveDownloadableVideo(videoId);
    if (!resolved) {
      this.lastPushError = 'Video chưa tải xong trên máy tính hoặc không tồn tại.';
      this.emit('change');
      return false;
    }

    const { item, fullPath } = resolved;
    this.activePushVideoId = videoId;
    this.lastPushError = null;
    this.lastPushMessage = `Đang chuẩn bị bắn "${item.fileName}" sang ${peer.alias}...`;
    this.folderWatcher.markTransferProgress(videoId, 0, item.sizeBytes);
    this.emit('change');

    try {
      let servePath = fullPath;
      let totalSize = item.sizeBytes;
      let serveFileName = item.fileName;
      let serveMimeType: string = item.mimeType;

      // Losslessly remux MKV/WebM -> MP4 so LocalSend on iPhone saves straight into Apple Photos!
      if (item.needsIosRemux) {
        const remuxed = await this.mkvRemuxer.ensureIosMp4(
          fullPath,
          item.sizeBytes,
          item.modifiedAtMs
        );
        if (remuxed) {
          servePath = remuxed.mp4FilePath;
          totalSize = remuxed.sizeBytes;
          const stem = path.basename(item.fileName, path.extname(item.fileName));
          serveFileName = `${stem}.mp4`;
          serveMimeType = 'video/mp4';
        }
      }

      // Phase 1: POST /api/localsend/v2/prepare-upload
      const prepareResult = await this.callPrepareUpload(peer, {
        fileId: item.id,
        fileName: serveFileName,
        size: totalSize,
        fileType: serveMimeType
      });

      if (!prepareResult.ok) {
        this.lastPushError = prepareResult.errorMessage;
        this.lastPushMessage = null;
        this.folderWatcher.markTransferError(videoId, prepareResult.errorMessage);
        return false;
      }

      if (prepareResult.alreadyDone || !prepareResult.sessionId || !prepareResult.fileToken) {
        this.folderWatcher.markSavedToPhotos(videoId);
        this.lastPushMessage = `Đã gửi xong "${serveFileName}" sang Ảnh trên ${peer.alias}!`;
        return true;
      }

      // Phase 2: Stream binary file to POST /api/localsend/v2/upload
      this.lastPushMessage = `Đang bắn "${serveFileName}" sang ${peer.alias}...`;
      this.emit('change');

      await this.streamFileToLocalSend(peer, {
        videoId,
        originalSizeBytes: item.sizeBytes,
        servePath,
        totalSize,
        sessionId: prepareResult.sessionId,
        fileToken: prepareResult.fileToken
      });

      this.folderWatcher.markSavedToPhotos(videoId);
      this.lastPushMessage = `Đã bắn "${serveFileName}" thẳng vào Ảnh trên ${peer.alias}!`;
      this.lastPushError = null;
      return true;
    } catch (err: unknown) {
      const msg =
        err instanceof Error
          ? err.message
          : 'Không thể kết nối tới LocalSend trên iPhone. Hãy mở màn hình app LocalSend trên iPhone và thử lại.';
      this.lastPushError = msg;
      this.lastPushMessage = null;
      this.folderWatcher.markTransferError(videoId, msg);
      return false;
    } finally {
      this.activePushVideoId = null;
      this.emit('change');
    }
  }

  private callPrepareUpload(
    peer: LocalSendPeer,
    fileMeta: { fileId: string; fileName: string; size: number; fileType: string }
  ): Promise<
    | { ok: true; alreadyDone?: boolean; sessionId?: string; fileToken?: string }
    | { ok: false; errorMessage: string }
  > {
    return new Promise((resolve) => {
      const mod = peer.protocol === 'https' ? https : http;
      const pinQuery = this.pin ? `?pin=${encodeURIComponent(this.pin)}` : '';
      const payload = JSON.stringify({
        info: this.getSenderInfoPayload(),
        files: {
          [fileMeta.fileId]: {
            id: fileMeta.fileId,
            fileName: fileMeta.fileName,
            size: fileMeta.size,
            fileType: fileMeta.fileType
          }
        }
      });

      const req = mod.request(
        {
          hostname: peer.ip,
          port: peer.port,
          path: `/api/localsend/v2/prepare-upload${pinQuery}`,
          method: 'POST',
          timeout: 45000,
          ...(peer.protocol === 'https' ? this.getHttpsClientTlsOptions() : {}),
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Content-Length': Buffer.byteLength(payload)
          }
        },
        (res) => {
          const code = res.statusCode ?? 0;
          if (code === 204) {
            res.resume();
            resolve({ ok: true, alreadyDone: true });
            return;
          }
          if (code === 401) {
            res.resume();
            resolve({
              ok: false,
              errorMessage:
                'LocalSend trên iPhone đang yêu cầu mã PIN. Hãy nhập mã PIN LocalSend ở khung cấu hình bên trái.'
            });
            return;
          }
          if (code === 403) {
            res.resume();
            resolve({
              ok: false,
              errorMessage: 'Đã từ chối nhận video trên màn hình iPhone.'
            });
            return;
          }
          if (code === 409) {
            res.resume();
            resolve({
              ok: false,
              errorMessage: 'iPhone đang bận nhận một luồng file khác. Hãy thử lại sau vài giây.'
            });
            return;
          }
          if (code !== 200) {
            res.resume();
            resolve({
              ok: false,
              errorMessage: `LocalSend trên iPhone phản hồi mã lỗi ${code}.`
            });
            return;
          }

          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            try {
              const parsed = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as {
                sessionId?: string;
                files?: Record<string, string>;
              };
              const token = parsed.files?.[fileMeta.fileId];
              resolve({
                ok: true,
                sessionId: parsed.sessionId,
                fileToken: token
              });
            } catch {
              resolve({
                ok: false,
                errorMessage: 'Phản hồi từ LocalSend không đúng định dạng.'
              });
            }
          });
        }
      );

      req.on('timeout', () => {
        req.destroy();
        resolve({
          ok: false,
          errorMessage: 'Chưa xác nhận trên iPhone — hãy bật "Lưu nhanh (Quick Save)" trong LocalSend.'
        });
      });

      req.on('error', (err) => {
        resolve({
          ok: false,
          errorMessage: this.formatConnectionError(err, peer)
        });
      });

      req.write(payload);
      req.end();
    });
  }

  private streamFileToLocalSend(
    peer: LocalSendPeer,
    params: {
      videoId: string;
      originalSizeBytes: number;
      servePath: string;
      totalSize: number;
      sessionId: string;
      fileToken: string;
    }
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const mod = peer.protocol === 'https' ? https : http;
      const query = `?sessionId=${encodeURIComponent(
        params.sessionId
      )}&fileId=${encodeURIComponent(params.videoId)}&token=${encodeURIComponent(
        params.fileToken
      )}`;

      const req = mod.request(
        {
          hostname: peer.ip,
          port: peer.port,
          path: `/api/localsend/v2/upload${query}`,
          method: 'POST',
          ...(peer.protocol === 'https' ? this.getHttpsClientTlsOptions() : {}),
          headers: {
            'Content-Type': 'application/octet-stream',
            'Content-Length': String(params.totalSize)
          }
        },
        (res) => {
          res.resume();
          if (res.statusCode === 200) {
            resolve();
          } else {
            reject(
              new Error(`Truyền dữ liệu sang LocalSend thất bại (HTTP ${res.statusCode ?? 0}).`)
            );
          }
        }
      );

      const readStream = fs.createReadStream(params.servePath, {
        highWaterMark: STREAM_CHUNK_SIZE
      });

      let sentBytes = 0;
      let lastReportAt = 0;

      readStream.on('data', (chunk: Buffer | string) => {
        const len = typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length;
        sentBytes += len;

        const ok = req.write(chunk);
        if (!ok) {
          readStream.pause();
          req.once('drain', () => readStream.resume());
        }

        const now = Date.now();
        if (now - lastReportAt >= 120) {
          lastReportAt = now;
          const scaledBytes = Math.round(
            (sentBytes / Math.max(1, params.totalSize)) * params.originalSizeBytes
          );
          this.folderWatcher.markTransferProgress(
            params.videoId,
            scaledBytes,
            params.originalSizeBytes
          );
        }
      });

      readStream.on('end', () => {
        req.end();
      });

      readStream.on('error', () => {
        req.destroy();
        reject(new Error('Lỗi đọc file video trên ổ cứng khi đang bắn sang iPhone.'));
      });

      req.on('error', () => {
        readStream.destroy();
        reject(
          new Error(
            'Đứt kết nối Wi-Fi khi đang bắn sang iPhone. Hãy giữ màn hình LocalSend trên iPhone sáng cho tới khi xong.'
          )
        );
      });
    });
  }
}
