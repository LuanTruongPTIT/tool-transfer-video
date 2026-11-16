import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import chokidar, { FSWatcher } from 'chokidar';
import {
  SupportedVideoExtension,
  SupportedVideoMimeType,
  VideoItem,
  VideoLifecycleStatus
} from '../shared/types';
import {
  getSupportedVideoExtension,
  getVideoMimeType,
  hasCompanionTempFile,
  isBrowserTempFile,
  probeVideoHeaderReadOnly,
  requiresIosMp4Remux
} from './fileStability';

export interface FolderWatcherOptions {
  stabilityWindowMs?: number;
  pollIntervalMs?: number;
  maxInvalidWaitMs?: number;
}

interface InternalVideoRecord {
  id: string;
  fullPath: string;
  fileName: string;
  extension: SupportedVideoExtension;
  mimeType: SupportedVideoMimeType;
  needsIosRemux: boolean;
  sizeBytes: number;
  modifiedAtMs: number;
  createdOrChangedAtMs: number;
  detectedAtMs: number;
  status: VideoLifecycleStatus;
  transferredBytes: number;
  transferPercent: number;
  errorMessage?: string;
  downloadedAtMs?: number;
  savedToPhotosAtMs?: number;
  downloadCount: number;
  // Stability tracking fields
  lastObservedSize: number;
  lastObservedMtimeMs: number;
  stableSinceMs: number;
  firstSeenUnstableMs: number;
}

const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

export class FolderWatcher extends EventEmitter {
  private readonly stabilityWindowMs: number;
  private readonly pollIntervalMs: number;
  private readonly maxInvalidWaitMs: number;
  private readonly idSalt: string;

  private watchedFolder: string | null = null;
  private filterRecent24h = true;
  private watcher: FSWatcher | null = null;
  private stabilityTimer: NodeJS.Timeout | null = null;
  private checkingStability = false;

  private recordsByPath = new Map<string, InternalVideoRecord>();
  private recordsById = new Map<string, InternalVideoRecord>();
  private activeTempFiles = new Set<string>();

  constructor(options: FolderWatcherOptions = {}) {
    super();
    this.stabilityWindowMs = options.stabilityWindowMs ?? 2000;
    this.pollIntervalMs = options.pollIntervalMs ?? 500;
    this.maxInvalidWaitMs = options.maxInvalidWaitMs ?? 15000;
    this.idSalt = crypto.randomBytes(16).toString('hex');
  }

  public getWatchedFolder(): string | null {
    return this.watchedFolder;
  }

  public getFilterRecent24h(): boolean {
    return this.filterRecent24h;
  }

  public setFilterRecent24h(recent24h: boolean): void {
    if (this.filterRecent24h !== recent24h) {
      this.filterRecent24h = recent24h;
      this.emitChange();
    }
  }

  public async startWatching(folderPath: string | null): Promise<void> {
    await this.stopWatching();

    if (!folderPath) {
      this.watchedFolder = null;
      this.emitChange();
      return;
    }

    const resolvedFolder = path.resolve(folderPath);
    const stat = await fs.promises.stat(resolvedFolder);
    if (!stat.isDirectory()) {
      throw new Error('Đường dẫn đã chọn không phải là một thư mục hợp lệ.');
    }

    this.watchedFolder = resolvedFolder;

    // Initial top-level directory scan (non-recursive so Downloads subfolders aren't accidentally exposed)
    await this.performInitialScan(resolvedFolder);

    this.watcher = chokidar.watch(resolvedFolder, {
      depth: 0,
      ignoreInitial: true,
      persistent: true,
      followSymlinks: false,
      ignorePermissionErrors: true
    });

    this.watcher.on('add', (filePath) => {
      void this.handleFsUpsert(filePath, false);
    });
    this.watcher.on('change', (filePath) => {
      void this.handleFsUpsert(filePath, false);
    });
    this.watcher.on('unlink', (filePath) => {
      this.handleFsRemove(filePath);
    });

    this.ensureStabilityLoop();
    this.emitChange();
  }

  public async stopWatching(): Promise<void> {
    if (this.stabilityTimer) {
      clearInterval(this.stabilityTimer);
      this.stabilityTimer = null;
    }
    if (this.watcher) {
      await this.watcher.close().catch(() => undefined);
      this.watcher = null;
    }
    this.recordsByPath.clear();
    this.recordsById.clear();
    this.activeTempFiles.clear();
  }

  private generateOpaqueId(fullPath: string): string {
    return crypto
      .createHmac('sha256', this.idSalt)
      .update(fullPath)
      .digest('hex')
      .slice(0, 16);
  }

  private isDirectChildOfWatchedFolder(targetPath: string): boolean {
    if (!this.watchedFolder) return false;
    const resolved = path.resolve(targetPath);
    return path.dirname(resolved) === this.watchedFolder;
  }

  private async performInitialScan(folderPath: string): Promise<void> {
    let entries: fs.Dirent[] = [];
    try {
      entries = await fs.promises.readdir(folderPath, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.isSymbolicLink() || !entry.isFile()) {
        continue;
      }
      const fullPath = path.join(folderPath, entry.name);
      await this.handleFsUpsert(fullPath, true);
    }
  }

  private async handleFsUpsert(rawPath: string, isInitialScan: boolean): Promise<void> {
    const fullPath = path.resolve(rawPath);
    if (!this.isDirectChildOfWatchedFolder(fullPath)) {
      return;
    }

    const fileName = path.basename(fullPath);
    if (isBrowserTempFile(fileName)) {
      this.activeTempFiles.add(fullPath);
      this.emitChange();
      return;
    }

    const ext = getSupportedVideoExtension(fileName);
    if (!ext) {
      return;
    }

    let lstat: fs.Stats;
    try {
      lstat = await fs.promises.lstat(fullPath);
    } catch {
      this.handleFsRemove(fullPath);
      return;
    }

    // Never serve symbolic links or directories
    if (lstat.isSymbolicLink() || !lstat.isFile()) {
      return;
    }

    const now = Date.now();
    const existing = this.recordsByPath.get(fullPath);

    if (existing) {
      const changedOnDisk =
        existing.lastObservedSize !== lstat.size ||
        existing.lastObservedMtimeMs !== lstat.mtimeMs;

      if (changedOnDisk) {
        existing.sizeBytes = lstat.size;
        existing.modifiedAtMs = lstat.mtimeMs;
        existing.createdOrChangedAtMs = Math.max(lstat.mtimeMs, lstat.ctimeMs);
        existing.lastObservedSize = lstat.size;
        existing.lastObservedMtimeMs = lstat.mtimeMs;
        existing.stableSinceMs = now;
        existing.firstSeenUnstableMs = now;
        existing.status = 'waiting_complete';
        existing.errorMessage = undefined;
        this.ensureStabilityLoop();
        this.emitChange();
      }
      return;
    }

    const id = this.generateOpaqueId(fullPath);
    const mimeType = getVideoMimeType(ext);
    const createdOrChangedAtMs = Math.max(lstat.mtimeMs, lstat.ctimeMs);

    const record: InternalVideoRecord = {
      id,
      fullPath,
      fileName,
      extension: ext,
      mimeType,
      needsIosRemux: requiresIosMp4Remux(ext),
      sizeBytes: lstat.size,
      modifiedAtMs: lstat.mtimeMs,
      createdOrChangedAtMs,
      detectedAtMs: now,
      status: 'waiting_complete',
      transferredBytes: 0,
      transferPercent: 0,
      downloadCount: 0,
      lastObservedSize: lstat.size,
      lastObservedMtimeMs: lstat.mtimeMs,
      stableSinceMs: now,
      firstSeenUnstableMs: now
    };

    // Fast-path for already settled files during initial scan
    if (
      isInitialScan &&
      lstat.size > 0 &&
      now - createdOrChangedAtMs >= this.stabilityWindowMs * 2
    ) {
      const hasTemp = await hasCompanionTempFile(fullPath);
      if (!hasTemp) {
        const probe = await probeVideoHeaderReadOnly(fullPath, ext);
        if (probe.state === 'valid') {
          record.status = 'ready';
        } else if (probe.state === 'invalid') {
          record.status = 'invalid';
          record.errorMessage = probe.reason;
        }
      }
    }

    this.recordsByPath.set(fullPath, record);
    this.recordsById.set(id, record);
    if (record.status === 'waiting_complete') {
      this.ensureStabilityLoop();
    }
    this.emitChange();
  }

  private handleFsRemove(rawPath: string): void {
    const fullPath = path.resolve(rawPath);
    if (this.activeTempFiles.delete(fullPath)) {
      this.emitChange();
      return;
    }
    const existing = this.recordsByPath.get(fullPath);
    if (existing) {
      this.recordsByPath.delete(fullPath);
      this.recordsById.delete(existing.id);
      this.emitChange();
    }
  }

  private ensureStabilityLoop(): void {
    if (this.stabilityTimer) return;
    this.stabilityTimer = setInterval(() => {
      void this.evaluatePendingFiles();
    }, this.pollIntervalMs);
  }

  private async evaluatePendingFiles(): Promise<void> {
    if (this.checkingStability) return;
    this.checkingStability = true;

    let anyChanged = false;
    let stillHasWaiting = false;

    try {
      // Clean up stale temp files that may have been renamed quickly
      for (const tempPath of Array.from(this.activeTempFiles)) {
        try {
          await fs.promises.access(tempPath, fs.constants.F_OK);
        } catch {
          this.activeTempFiles.delete(tempPath);
          anyChanged = true;
        }
      }

      for (const record of Array.from(this.recordsByPath.values())) {
        if (record.status !== 'waiting_complete') {
          continue;
        }

        let lstat: fs.Stats;
        try {
          lstat = await fs.promises.lstat(record.fullPath);
        } catch {
          this.recordsByPath.delete(record.fullPath);
          this.recordsById.delete(record.id);
          anyChanged = true;
          continue;
        }

        if (lstat.isSymbolicLink() || !lstat.isFile()) {
          this.recordsByPath.delete(record.fullPath);
          this.recordsById.delete(record.id);
          anyChanged = true;
          continue;
        }

        const now = Date.now();
        if (
          lstat.size !== record.lastObservedSize ||
          lstat.mtimeMs !== record.lastObservedMtimeMs
        ) {
          record.sizeBytes = lstat.size;
          record.modifiedAtMs = lstat.mtimeMs;
          record.createdOrChangedAtMs = Math.max(lstat.mtimeMs, lstat.ctimeMs);
          record.lastObservedSize = lstat.size;
          record.lastObservedMtimeMs = lstat.mtimeMs;
          record.stableSinceMs = now;
          anyChanged = true;
          stillHasWaiting = true;
          continue;
        }

        if (lstat.size === 0) {
          if (now - record.firstSeenUnstableMs >= this.maxInvalidWaitMs) {
            record.status = 'invalid';
            record.errorMessage = 'File có dung lượng 0 byte (tải xuống bị lỗi hoặc rỗng).';
            anyChanged = true;
          } else {
            stillHasWaiting = true;
          }
          continue;
        }

        const companionExists = await hasCompanionTempFile(record.fullPath);
        if (companionExists) {
          record.stableSinceMs = now;
          stillHasWaiting = true;
          continue;
        }

        if (now - record.stableSinceMs < this.stabilityWindowMs) {
          stillHasWaiting = true;
          continue;
        }

        const probe = await probeVideoHeaderReadOnly(record.fullPath, record.extension);
        if (probe.state === 'valid') {
          record.status = 'ready';
          record.errorMessage = undefined;
          anyChanged = true;
        } else if (probe.state === 'locked') {
          record.stableSinceMs = now;
          stillHasWaiting = true;
        } else {
          // Give very slow flushers up to maxInvalidWaitMs before declaring invalid
          if (now - record.firstSeenUnstableMs >= this.maxInvalidWaitMs) {
            record.status = 'invalid';
            record.errorMessage = probe.reason;
            anyChanged = true;
          } else {
            stillHasWaiting = true;
          }
        }
      }
    } finally {
      this.checkingStability = false;
      if (!stillHasWaiting && this.activeTempFiles.size === 0 && this.stabilityTimer) {
        clearInterval(this.stabilityTimer);
        this.stabilityTimer = null;
      }
      if (anyChanged) {
        this.emitChange();
      }
    }
  }

  private toPublicVideoItem(rec: InternalVideoRecord): VideoItem {
    return {
      id: rec.id,
      fileName: rec.fileName,
      extension: rec.extension,
      mimeType: rec.mimeType,
      needsIosRemux: rec.needsIosRemux,
      sizeBytes: rec.sizeBytes,
      modifiedAtMs: rec.modifiedAtMs,
      detectedAtMs: rec.detectedAtMs,
      status: rec.status,
      transferredBytes: rec.transferredBytes,
      transferPercent: rec.transferPercent,
      errorMessage: rec.errorMessage,
      downloadedAtMs: rec.downloadedAtMs,
      savedToPhotosAtMs: rec.savedToPhotosAtMs,
      downloadCount: rec.downloadCount
    };
  }

  public getSnapshot(): {
    videos: VideoItem[];
    totalVideosInFolder: number;
    hiddenOlderCount: number;
    activeBrowserDownloadsCount: number;
  } {
    const allRecords = Array.from(this.recordsByPath.values()).sort((a, b) => {
      const timeA = Math.max(a.createdOrChangedAtMs, a.modifiedAtMs);
      const timeB = Math.max(b.createdOrChangedAtMs, b.modifiedAtMs);
      return timeB - timeA;
    });

    const totalVideosInFolder = allRecords.length;
    const cutoff = Date.now() - TWENTY_FOUR_HOURS_MS;

    const filtered = this.filterRecent24h
      ? allRecords.filter(
          (r) => Math.max(r.createdOrChangedAtMs, r.modifiedAtMs) >= cutoff
        )
      : allRecords;

    const hiddenOlderCount = Math.max(0, totalVideosInFolder - filtered.length);

    return {
      videos: filtered.map((r) => this.toPublicVideoItem(r)),
      totalVideosInFolder,
      hiddenOlderCount,
      activeBrowserDownloadsCount: this.activeTempFiles.size
    };
  }

  /**
   * Resolves a ready/downloadable video strictly by opaque ID and verifies it remains
   * inside the selected watched folder as a non-symlink regular file.
   */
  public async resolveDownloadableVideo(
    videoId: string
  ): Promise<{ item: VideoItem; fullPath: string } | null> {
    if (!this.watchedFolder) return null;
    const rec = this.recordsById.get(videoId);
    if (!rec) return null;
    if (rec.status === 'waiting_complete' || rec.status === 'invalid') {
      return null;
    }

    if (!this.isDirectChildOfWatchedFolder(rec.fullPath)) {
      return null;
    }

    try {
      const lstat = await fs.promises.lstat(rec.fullPath);
      if (lstat.isSymbolicLink() || !lstat.isFile()) {
        return null;
      }
      rec.sizeBytes = lstat.size;
      return {
        item: this.toPublicVideoItem(rec),
        fullPath: rec.fullPath
      };
    } catch {
      return null;
    }
  }

  public markTransferProgress(videoId: string, transferredBytes: number, totalBytes: number): void {
    const rec = this.recordsById.get(videoId);
    if (!rec) return;

    const clampedBytes = Math.min(totalBytes, Math.max(0, transferredBytes));
    const percent = totalBytes > 0 ? Math.min(99, Math.floor((clampedBytes / totalBytes) * 100)) : 0;

    const statusChanged = rec.status !== 'transferring';
    const percentChanged = rec.transferPercent !== percent;

    rec.status = 'transferring';
    rec.transferredBytes = clampedBytes;
    rec.transferPercent = percent;
    rec.errorMessage = undefined;

    if (statusChanged || percentChanged) {
      this.emitChange();
    }
  }

  public markDownloadedToSafari(videoId: string, totalBytes: number): void {
    const rec = this.recordsById.get(videoId);
    if (!rec) return;

    rec.status = 'downloaded_to_safari';
    rec.transferredBytes = totalBytes;
    rec.transferPercent = 100;
    rec.downloadedAtMs = Date.now();
    rec.downloadCount += 1;
    rec.errorMessage = undefined;
    this.emitChange();
  }

  public markTransferError(videoId: string, errorMessage: string): void {
    const rec = this.recordsById.get(videoId);
    if (!rec) return;

    // Do not downgrade if already confirmed saved to Photos and user canceled a duplicate pull
    if (rec.status === 'saved_to_photos') return;

    rec.status = 'transfer_error';
    rec.errorMessage = errorMessage;
    this.emitChange();
  }

  public markSavedToPhotos(videoId: string): boolean {
    const rec = this.recordsById.get(videoId);
    if (!rec) return false;
    if (rec.status === 'waiting_complete' || rec.status === 'invalid') {
      return false;
    }
    const now = Date.now();
    if (rec.status === 'transferring' || rec.status === 'ready') {
      rec.downloadCount += 1;
      rec.downloadedAtMs = now;
    }
    rec.status = 'saved_to_photos';
    rec.transferPercent = 100;
    rec.transferredBytes = rec.sizeBytes;
    rec.savedToPhotosAtMs = now;
    rec.errorMessage = undefined;
    this.emitChange();
    return true;
  }

  private emitChange(): void {
    this.emit('change');
  }
}
