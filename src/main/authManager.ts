import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PairedDeviceInfo } from '../shared/types';
import { formatFriendlyIosDeviceLabel } from './networkUtils';

export interface AuthManagerOptions {
  sessionTtlMs?: number;
  mediaTicketTtlMs?: number;
  maxPinAttempts?: number;
}

export type PairAttemptResult =
  | {
      ok: true;
      sessionToken: string;
      session: PairedDeviceInfo;
    }
  | {
      ok: false;
      statusCode: number;
      code:
        | 'MISSING_QR_KEY'
        | 'INVALID_QR_KEY'
        | 'DEVICE_ALREADY_PAIRED'
        | 'INVALID_PIN'
        | 'PIN_ROTATED_TOO_MANY_ATTEMPTS';
      message: string;
      remainingAttempts?: number;
    };

const TEN_HOURS_MS = 10 * 60 * 60 * 1000;
const TEN_MINUTES_MS = 10 * 60 * 1000;

export class AuthManager extends EventEmitter {
  private readonly sessionTtlMs: number;
  private readonly mediaTicketTtlMs: number;
  private readonly maxPinAttempts: number;

  private signingSecret: Buffer;
  private qrKey: string;
  private pinCode: string;
  private failedPinAttempts = 0;
  private activeSession: PairedDeviceInfo | null = null;

  constructor(options: AuthManagerOptions = {}) {
    super();
    this.sessionTtlMs = options.sessionTtlMs ?? TEN_HOURS_MS;
    this.mediaTicketTtlMs = options.mediaTicketTtlMs ?? TEN_MINUTES_MS;
    this.maxPinAttempts = options.maxPinAttempts ?? 5;
    this.signingSecret = crypto.randomBytes(32);
    this.qrKey = this.generateRandomQrKey();
    this.pinCode = this.generateRandomPin();
  }

  private generateRandomQrKey(): string {
    return crypto.randomBytes(16).toString('hex');
  }

  private generateRandomPin(): string {
    const num = crypto.randomInt(0, 1000000);
    return num.toString().padStart(6, '0');
  }

  private timingSafeEqualStr(a: string, b: string): boolean {
    const bufA = Buffer.from(a, 'utf-8');
    const bufB = Buffer.from(b, 'utf-8');
    if (bufA.length !== bufB.length) {
      // Constant-time dummy compare to avoid length leak timing
      crypto.timingSafeEqual(bufA, bufA);
      return false;
    }
    return crypto.timingSafeEqual(bufA, bufB);
  }

  private signPayload(payload: string): string {
    return crypto
      .createHmac('sha256', this.signingSecret)
      .update(payload)
      .digest('base64url');
  }

  public getQrKey(): string {
    return this.qrKey;
  }

  public getPinCode(): string {
    return this.pinCode;
  }

  public getFailedPinAttempts(): number {
    return this.failedPinAttempts;
  }

  public getMaxPinAttempts(): number {
    return this.maxPinAttempts;
  }

  public getSessionTtlSeconds(): number {
    return Math.floor(this.sessionTtlMs / 1000);
  }

  public getPairedDevice(): PairedDeviceInfo | null {
    this.pruneExpiredSession();
    return this.activeSession ? { ...this.activeSession } : null;
  }

  private pruneExpiredSession(): void {
    if (this.activeSession && Date.now() >= this.activeSession.expiresAtMs) {
      this.activeSession = null;
      this.emit('change');
    }
  }

  /**
   * Rotates QR key, 6-digit PIN, and signing secret, immediately revoking any paired session
   * and invalidating all outstanding session cookies and download tickets.
   */
  public rotateCredentials(): void {
    this.signingSecret = crypto.randomBytes(32);
    this.qrKey = this.generateRandomQrKey();
    this.pinCode = this.generateRandomPin();
    this.failedPinAttempts = 0;
    this.activeSession = null;
    this.emit('change');
  }

  /**
   * Disconnects the currently paired device and generates a fresh PIN + QR key.
   */
  public disconnectPairedDevice(): void {
    this.rotateCredentials();
  }

  public attemptPairing(params: {
    qrKey: string | undefined;
    pinCode: string | undefined;
    remoteIp: string;
    userAgent: string | undefined;
  }): PairAttemptResult {
    this.pruneExpiredSession();

    if (this.activeSession) {
      return {
        ok: false,
        statusCode: 409,
        code: 'DEVICE_ALREADY_PAIRED',
        message:
          'Máy tính này đang ghép đôi với một iPhone khác. Hãy bấm "Ngắt kết nối / Đổi mã" trên màn hình Windows nếu bạn muốn kết nối thiết bị mới.'
      };
    }

    const cleanQrKey = (params.qrKey ?? '').trim();
    if (!cleanQrKey) {
      return {
        ok: false,
        statusCode: 401,
        code: 'MISSING_QR_KEY',
        message: 'Thiếu khóa phiên từ mã QR. Vui lòng dùng Camera iPhone quét lại mã QR trên màn hình máy tính.'
      };
    }

    if (!this.timingSafeEqualStr(cleanQrKey, this.qrKey)) {
      return {
        ok: false,
        statusCode: 401,
        code: 'INVALID_QR_KEY',
        message: 'Mã QR đã cũ hoặc đã được làm mới. Vui lòng quét lại mã QR hiện tại trên màn hình máy tính.'
      };
    }

    const cleanPin = (params.pinCode ?? '').replace(/\s+/g, '');
    if (!this.timingSafeEqualStr(cleanPin, this.pinCode)) {
      this.failedPinAttempts += 1;
      if (this.failedPinAttempts >= this.maxPinAttempts) {
        this.rotateCredentials();
        return {
          ok: false,
          statusCode: 429,
          code: 'PIN_ROTATED_TOO_MANY_ATTEMPTS',
          message:
            'Nhập sai mã ghép đôi quá số lần cho phép. Mã QR và PIN trên máy tính đã tự động đổi mới để bảo mật — vui lòng quét lại mã QR mới.',
          remainingAttempts: 0
        };
      }

      const remaining = this.maxPinAttempts - this.failedPinAttempts;
      this.emit('change');
      return {
        ok: false,
        statusCode: 401,
        code: 'INVALID_PIN',
        message: `Mã ghép đôi không đúng. Còn ${remaining} lần thử trước khi tự động đổi mã mới.`,
        remainingAttempts: remaining
      };
    }

    // Pairing succeeded! Lock 1-to-1 session for work shift
    const now = Date.now();
    const sessionId = crypto.randomBytes(16).toString('hex');
    const expiresAtMs = now + this.sessionTtlMs;

    const session: PairedDeviceInfo = {
      sessionId,
      deviceLabel: formatFriendlyIosDeviceLabel(params.userAgent),
      ipAddress: params.remoteIp,
      pairedAtMs: now,
      expiresAtMs,
      lastSeenAtMs: now
    };

    this.activeSession = session;
    this.failedPinAttempts = 0;

    const tokenPayload = `${sessionId}.${expiresAtMs}`;
    const sig = this.signPayload(`session:${tokenPayload}`);
    const sessionToken = `${tokenPayload}.${sig}`;

    this.emit('change');
    return {
      ok: true,
      sessionToken,
      session: { ...session }
    };
  }

  public verifySessionToken(token: string | undefined): PairedDeviceInfo | null {
    this.pruneExpiredSession();
    if (!token || !this.activeSession) return null;

    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [sessionId, expiresStr, providedSig] = parts;
    const expiresAtMs = Number(expiresStr);
    if (!Number.isFinite(expiresAtMs) || Date.now() >= expiresAtMs) {
      return null;
    }

    const expectedSig = this.signPayload(`session:${sessionId}.${expiresStr}`);
    if (!this.timingSafeEqualStr(providedSig, expectedSig)) {
      return null;
    }

    if (!this.timingSafeEqualStr(sessionId, this.activeSession.sessionId)) {
      return null;
    }

    this.activeSession.lastSeenAtMs = Date.now();
    return { ...this.activeSession };
  }

  /**
   * Creates a short-lived signed URL ticket tied to the active session ID and specific video ID.
   * Needed so iOS Safari's out-of-process media player (206 Range requests) and native Download
   * Manager work reliably while remaining strictly authenticated and revocable.
   */
  public createMediaTicket(
    sessionId: string,
    videoId: string,
    purpose: 'preview' | 'download'
  ): string {
    const expiresAtMs = Date.now() + this.mediaTicketTtlMs;
    const body = `${sessionId}.${videoId}.${purpose}.${expiresAtMs}`;
    const sig = this.signPayload(`ticket:${body}`);
    return `${body}.${sig}`;
  }

  public verifyMediaTicket(
    ticket: string | undefined,
    expectedVideoId: string,
    expectedPurpose: 'preview' | 'download'
  ): PairedDeviceInfo | null {
    this.pruneExpiredSession();
    if (!ticket || !this.activeSession) return null;

    const parts = ticket.split('.');
    if (parts.length !== 5) return null;
    const [sessionId, videoId, purpose, expiresStr, providedSig] = parts;
    const expiresAtMs = Number(expiresStr);

    if (!Number.isFinite(expiresAtMs) || Date.now() >= expiresAtMs) {
      return null;
    }

    if (videoId !== expectedVideoId || purpose !== expectedPurpose) {
      return null;
    }

    const expectedSig = this.signPayload(
      `ticket:${sessionId}.${videoId}.${purpose}.${expiresStr}`
    );
    if (!this.timingSafeEqualStr(providedSig, expectedSig)) {
      return null;
    }

    if (!this.timingSafeEqualStr(sessionId, this.activeSession.sessionId)) {
      return null;
    }

    this.activeSession.lastSeenAtMs = Date.now();
    return { ...this.activeSession };
  }

  /**
   * Creates a shift-duration token for the iPhone Home Screen "Quick Pull" WebClip
   * so Apple Shortcuts can pull pending videos straight into Photos in 1 tap,
   * while remaining revocable via "Ngắt / Đổi máy" on Windows.
   */
  public createShortcutToken(sessionId: string): string {
    const expiresAtMs = this.activeSession?.expiresAtMs ?? Date.now() + this.sessionTtlMs;
    const body = `${sessionId}.${expiresAtMs}`;
    const sig = this.signPayload(`shortcut:${body}`);
    return `${body}.${sig}`;
  }

  public verifyShortcutToken(token: string | undefined): PairedDeviceInfo | null {
    this.pruneExpiredSession();
    if (!token || !this.activeSession) return null;

    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [sessionId, expiresStr, providedSig] = parts;
    const expiresAtMs = Number(expiresStr);
    if (!Number.isFinite(expiresAtMs) || Date.now() >= expiresAtMs) {
      return null;
    }

    const expectedSig = this.signPayload(`shortcut:${sessionId}.${expiresStr}`);
    if (!this.timingSafeEqualStr(providedSig, expectedSig)) {
      return null;
    }

    if (!this.timingSafeEqualStr(sessionId, this.activeSession.sessionId)) {
      return null;
    }

    this.activeSession.lastSeenAtMs = Date.now();
    return { ...this.activeSession };
  }
}
