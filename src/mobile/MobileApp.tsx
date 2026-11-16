import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  BookmarkPlus,
  Check,
  CheckCircle2,
  Copy,
  Download,
  ExternalLink,
  FileVideo,
  HelpCircle,
  Loader2,
  Play,
  RefreshCw,
  Share,
  X,
  Zap
} from 'lucide-react';
import { MobileVideoItem, PairedDeviceInfo } from '../shared/types';
import appIconUrl from '../shared/appIcon.png';
import { formatClockTime, formatFileSize } from '../shared/formatters';

interface SessionResponse {
  authenticated: boolean;
  deviceAlreadyPairedOnPc?: boolean;
  device?: PairedDeviceInfo;
  watchedFolderSelected?: boolean;
  filterRecent24h?: boolean;
  totalVideosInFolder?: number;
  hiddenOlderCount?: number;
  activeBrowserDownloadsCount?: number;
  pendingPhotosCount?: number;
  batchShortcutSaveUrl?: string | null;
  quickPullHomeUrl?: string;
  icloudShortcutUrl?: string | null;
  videos?: MobileVideoItem[];
}

const QR_KEY_STORAGE = 'evd_qr_key';

function captureQrKeyFromUrl(): string {
  try {
    const params = new URLSearchParams(window.location.search);
    const k = params.get('k');
    if (k && k.trim()) {
      sessionStorage.setItem(QR_KEY_STORAGE, k.trim());
      window.history.replaceState({}, '', '/');
      return k.trim();
    }
    return sessionStorage.getItem(QR_KEY_STORAGE) ?? '';
  } catch {
    return '';
  }
}

export const MobileApp: React.FC = () => {
  const [loading, setLoading] = useState(true);
  const [authenticated, setAuthenticated] = useState(false);
  const [deviceAlreadyPairedOnPc, setDeviceAlreadyPairedOnPc] = useState(false);
  const [qrKey] = useState<string>(() => captureQrKeyFromUrl());
  const [pinInput, setPinInput] = useState('');
  const [pairError, setPairError] = useState<string | null>(null);
  const [pairingSubmitting, setPairingSubmitting] = useState(false);
  const [revokedNotice, setRevokedNotice] = useState<string | null>(null);

  const [watchedFolderSelected, setWatchedFolderSelected] = useState(true);
  const [filterRecent24h, setFilterRecent24h] = useState(true);
  const [totalVideosInFolder, setTotalVideosInFolder] = useState(0);
  const [hiddenOlderCount, setHiddenOlderCount] = useState(0);
  const [activeBrowserDownloadsCount, setActiveBrowserDownloadsCount] = useState(0);
  const [pendingPhotosCount, setPendingPhotosCount] = useState(0);
  const [batchShortcutSaveUrl, setBatchShortcutSaveUrl] = useState<string | null>(null);
  const [quickPullHomeUrl, setQuickPullHomeUrl] = useState<string>('/quick-pull');
  const [icloudShortcutUrl, setIcloudShortcutUrl] = useState<string | null>(null);
  const [videos, setVideos] = useState<MobileVideoItem[]>([]);
  const [connectionLost, setConnectionLost] = useState(false);
  const [previewVideo, setPreviewVideo] = useState<MobileVideoItem | null>(null);
  const [previewCodecError, setPreviewCodecError] = useState(false);
  const [showShortcutGuideModal, setShowShortcutGuideModal] = useState(false);
  const [copiedShortcutName, setCopiedShortcutName] = useState(false);

  const pollUntilRef = useRef<number>(0);
  const wakeLockRef = useRef<{ release: () => Promise<void> } | null>(null);

  const applyVideoPayload = useCallback(
    (data: {
      watchedFolderSelected?: boolean;
      filterRecent24h?: boolean;
      totalVideosInFolder?: number;
      hiddenOlderCount?: number;
      activeBrowserDownloadsCount?: number;
      pendingPhotosCount?: number;
      batchShortcutSaveUrl?: string | null;
      quickPullHomeUrl?: string;
      icloudShortcutUrl?: string | null;
      videos?: MobileVideoItem[];
    }) => {
      if (typeof data.watchedFolderSelected === 'boolean') {
        setWatchedFolderSelected(data.watchedFolderSelected);
      }
      if (typeof data.filterRecent24h === 'boolean') {
        setFilterRecent24h(data.filterRecent24h);
      }
      if (typeof data.totalVideosInFolder === 'number') {
        setTotalVideosInFolder(data.totalVideosInFolder);
      }
      if (typeof data.hiddenOlderCount === 'number') {
        setHiddenOlderCount(data.hiddenOlderCount);
      }
      if (typeof data.activeBrowserDownloadsCount === 'number') {
        setActiveBrowserDownloadsCount(data.activeBrowserDownloadsCount);
      }
      if (typeof data.pendingPhotosCount === 'number') {
        setPendingPhotosCount(data.pendingPhotosCount);
      }
      if ('batchShortcutSaveUrl' in data) {
        setBatchShortcutSaveUrl(data.batchShortcutSaveUrl ?? null);
      }
      if (typeof data.quickPullHomeUrl === 'string' && data.quickPullHomeUrl) {
        setQuickPullHomeUrl(data.quickPullHomeUrl);
      }
      if ('icloudShortcutUrl' in data) {
        setIcloudShortcutUrl(data.icloudShortcutUrl ?? null);
      }
      if (Array.isArray(data.videos)) {
        setVideos(data.videos);
      }
    },
    []
  );

  const fetchSessionState = useCallback(async () => {
    try {
      const res = await fetch('/api/session', { cache: 'no-store' });
      if (!res.ok) {
        setConnectionLost(true);
        return;
      }
      setConnectionLost(false);
      const data = (await res.json()) as SessionResponse;
      if (!data.authenticated) {
        setAuthenticated(false);
        setDeviceAlreadyPairedOnPc(Boolean(data.deviceAlreadyPairedOnPc));
        return;
      }
      setAuthenticated(true);
      setRevokedNotice(null);
      applyVideoPayload(data);
    } catch {
      setConnectionLost(true);
    } finally {
      setLoading(false);
    }
  }, [applyVideoPayload]);

  const refreshVideosOnly = useCallback(async () => {
    try {
      const res = await fetch('/api/videos', { cache: 'no-store' });
      if (res.status === 401) {
        setAuthenticated(false);
        setRevokedNotice('Phiên đã kết thúc. Vui lòng quét lại mã QR trên máy tính.');
        return;
      }
      if (!res.ok) {
        setConnectionLost(true);
        return;
      }
      setConnectionLost(false);
      const data = await res.json();
      applyVideoPayload(data);
    } catch {
      setConnectionLost(true);
    }
  }, [applyVideoPayload]);

  useEffect(() => {
    void fetchSessionState();
  }, [fetchSessionState]);

  useEffect(() => {
    if (!authenticated) return;

    let es: EventSource | null = null;

    const connectSse = () => {
      if (es) es.close();
      es = new EventSource('/api/events');

      es.addEventListener('update', (evt) => {
        try {
          const parsed = JSON.parse((evt as MessageEvent).data);
          setConnectionLost(false);
          applyVideoPayload(parsed);
        } catch {
          // Ignore malformed frame
        }
      });

      es.addEventListener('revoked', () => {
        es?.close();
        setAuthenticated(false);
        setRevokedNotice('Máy tính vừa ngắt kết nối. Hãy quét lại mã QR.');
      });

      es.onerror = () => undefined;
    };

    connectSse();

    const onVisibilityOrFocus = () => {
      if (document.visibilityState === 'visible') {
        void refreshVideosOnly();
        connectSse();
      }
    };

    document.addEventListener('visibilitychange', onVisibilityOrFocus);
    window.addEventListener('pageshow', onVisibilityOrFocus);

    return () => {
      document.removeEventListener('visibilitychange', onVisibilityOrFocus);
      window.removeEventListener('pageshow', onVisibilityOrFocus);
      es?.close();
    };
  }, [authenticated, applyVideoPayload, refreshVideosOnly]);

  useEffect(() => {
    if (!authenticated) return;
    const anyTransferring = videos.some((v) => v.status === 'transferring');

    const interval = setInterval(() => {
      if (anyTransferring || Date.now() < pollUntilRef.current) {
        void refreshVideosOnly();
      }
    }, 1000);

    return () => clearInterval(interval);
  }, [authenticated, videos, refreshVideosOnly]);

  const requestTemporaryWakeLock = async () => {
    try {
      const nav = navigator as Navigator & {
        wakeLock?: { request: (type: 'screen') => Promise<{ release: () => Promise<void> }> };
      };
      if (nav.wakeLock && !wakeLockRef.current) {
        wakeLockRef.current = await nav.wakeLock.request('screen');
        setTimeout(() => {
          void wakeLockRef.current?.release().catch(() => undefined);
          wakeLockRef.current = null;
        }, 60000);
      }
    } catch {
      // Optional
    }
  };

  const handleDownloadTap = () => {
    pollUntilRef.current = Date.now() + 25000;
    void requestTemporaryWakeLock();
  };

  const handleCopyShortcutName = async () => {
    try {
      await navigator.clipboard.writeText('Ecom Video Drop');
      setCopiedShortcutName(true);
      setTimeout(() => setCopiedShortcutName(false), 2000);
    } catch {
      const input = document.createElement('input');
      input.value = 'Ecom Video Drop';
      document.body.appendChild(input);
      input.select();
      document.execCommand('copy');
      document.body.removeChild(input);
      setCopiedShortcutName(true);
      setTimeout(() => setCopiedShortcutName(false), 2000);
    }
  };

  const handleConfirmSavedToPhotos = async (videoId: string) => {
    try {
      const res = await fetch(`/api/videos/${encodeURIComponent(videoId)}/confirm-photos`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmed: true })
      });
      if (res.ok) {
        await refreshVideosOnly();
      }
    } catch {
      setConnectionLost(true);
    }
  };

  const handleToggleMobileFilter = async (recent24h: boolean) => {
    try {
      const res = await fetch('/api/filter', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recent24h })
      });
      if (res.ok) {
        const data = await res.json();
        applyVideoPayload(data);
      }
    } catch {
      setConnectionLost(true);
    }
  };

  const handleSubmitPin = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleaned = pinInput.replace(/\D/g, '');
    if (cleaned.length !== 6) {
      setPairError('Nhập đủ 6 chữ số mã PIN trên máy tính.');
      return;
    }

    setPairingSubmitting(true);
    setPairError(null);

    try {
      const res = await fetch('/api/pair', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ qrKey, pinCode: cleaned })
      });

      const data = await res.json();
      if (!res.ok || !data.ok) {
        setPairError(data.message ?? 'Mã PIN không đúng.');
        if (data.code === 'PIN_ROTATED_TOO_MANY_ATTEMPTS') {
          setPinInput('');
        }
        return;
      }

      setAuthenticated(true);
      setRevokedNotice(null);
      applyVideoPayload(data);
    } catch {
      setPairError('Mất kết nối Wi-Fi tới máy tính.');
    } finally {
      setPairingSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#F8FAFC] text-slate-500 text-sm">
        <Loader2 className="w-6 h-6 animate-spin text-indigo-600" />
      </div>
    );
  }

  // Minimalist Pairing Screen
  if (!authenticated) {
    return (
      <div className="min-h-screen bg-[#F8FAFC] flex flex-col justify-center p-5">
        <div className="max-w-sm w-full mx-auto bg-white rounded-3xl shadow-sm border border-slate-200/80 p-6 space-y-5">
          <div className="flex flex-col items-center text-center space-y-2">
            <img src={appIconUrl} alt="Ecom Video Drop" className="w-12 h-12 object-contain" />
            <h1 className="text-base font-bold text-slate-900">Ecom Video Drop</h1>
            <p className="text-xs text-slate-500">Nhập mã PIN 6 số hiển thị trên máy tính</p>
          </div>

          {revokedNotice && (
            <div className="p-3 rounded-2xl bg-amber-50 border border-amber-200 text-xs text-amber-900 text-center">
              {revokedNotice}
            </div>
          )}

          {deviceAlreadyPairedOnPc && !revokedNotice && (
            <div className="p-3 rounded-2xl bg-amber-50 border border-amber-200 text-xs text-amber-900 text-center">
              Máy tính đang kết nối với một iPhone khác. Bấm <strong>Ngắt</strong> trên PC để đổi máy.
            </div>
          )}

          {!qrKey && (
            <div className="p-3 rounded-2xl bg-rose-50 border border-rose-200 text-xs text-rose-700 text-center">
              Hãy mở Camera iPhone quét trực tiếp mã QR trên màn hình máy tính.
            </div>
          )}

          <form onSubmit={handleSubmitPin} className="space-y-3.5">
            <input
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              autoComplete="one-time-code"
              maxLength={6}
              placeholder="000000"
              value={pinInput}
              onChange={(e) => setPinInput(e.target.value.replace(/\D/g, '').slice(0, 6))}
              className="w-full text-center text-2xl font-mono font-bold tracking-[0.35em] py-3.5 px-4 rounded-2xl border border-slate-200 focus:border-indigo-600 focus:outline-none bg-slate-50 text-slate-900"
            />

            {pairError && (
              <p className="text-xs text-rose-600 text-center font-medium">{pairError}</p>
            )}

            <button
              type="submit"
              disabled={pairingSubmitting || !qrKey}
              className="w-full py-3.5 rounded-2xl bg-slate-900 text-white font-semibold text-sm active:bg-slate-800 disabled:opacity-40 flex items-center justify-center gap-2"
            >
              {pairingSubmitting ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Kết nối'}
            </button>
          </form>
        </div>
      </div>
    );
  }

  // Minimalist Authenticated Mobile Feed
  return (
    <div className="min-h-screen bg-[#F8FAFC] pb-10">
      <header className="sticky top-0 z-20 bg-white/90 backdrop-blur border-b border-slate-200/80 px-4 h-14 flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <img src={appIconUrl} alt="Ecom Video Drop" className="w-8 h-8 object-contain" />
          <span className="text-sm font-semibold text-slate-900">Ecom Video Drop</span>
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
        </div>

        <div className="flex items-center gap-1">
          <button
            onClick={() => setShowShortcutGuideModal(true)}
            className="p-2 rounded-xl text-slate-500 active:bg-slate-100"
            aria-label="Hướng dẫn Phím tắt"
          >
            <HelpCircle className="w-4 h-4" />
          </button>
          <button
            onClick={() => void refreshVideosOnly()}
            className="p-2 rounded-xl text-slate-500 active:bg-slate-100"
            aria-label="Làm mới"
          >
            <RefreshCw className="w-4 h-4" />
          </button>
        </div>
      </header>

      <main className="max-w-lg mx-auto p-4 space-y-3">
        {connectionLost && (
          <div className="px-3.5 py-2.5 rounded-2xl bg-rose-50 border border-rose-200 text-xs text-rose-700 flex items-center justify-between">
            <span>Mất kết nối Wi-Fi tới máy tính</span>
            <button
              onClick={() => void refreshVideosOnly()}
              className="font-semibold underline ml-2"
            >
              Thử lại
            </button>
          </div>
        )}

        {/* Compact 1-Tap Batch Card */}
        {watchedFolderSelected && (
          <div className="bg-white rounded-2xl border border-slate-200/80 p-3.5 space-y-2.5 shadow-[0_1px_2px_rgba(15,23,42,0.03)]">
            {pendingPhotosCount > 0 && batchShortcutSaveUrl && (
              <a
                href={batchShortcutSaveUrl}
                onClick={handleDownloadTap}
                className="w-full py-3 px-4 rounded-xl bg-emerald-600 text-white font-semibold text-xs flex items-center justify-center gap-1.5 active:bg-emerald-700"
              >
                <Zap className="w-4 h-4" />
                Lưu tất cả {pendingPhotosCount} video vào Ảnh
              </a>
            )}

            <div className="flex items-center justify-between text-xs text-slate-500 px-0.5">
              <button
                type="button"
                onClick={() => setShowShortcutGuideModal(true)}
                className="font-medium text-emerald-700"
              >
                Cài Phím tắt 1 chạm
              </button>
              <a href={quickPullHomeUrl} className="inline-flex items-center gap-1 font-medium">
                <BookmarkPlus className="w-3.5 h-3.5" />
                Gắn ra MH chính
              </a>
            </div>
          </div>
        )}

        {activeBrowserDownloadsCount > 0 && (
          <div className="px-3.5 py-2.5 rounded-2xl bg-indigo-50 text-xs text-indigo-800 flex items-center gap-2">
            <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" />
            <span>Máy tính đang tải {activeBrowserDownloadsCount} file...</span>
          </div>
        )}

        {watchedFolderSelected && totalVideosInFolder > 0 && (
          <div className="flex items-center justify-between px-1 pt-1">
            <span className="text-xs font-semibold text-slate-600">Video ({videos.length})</span>
            <div className="inline-flex rounded-xl bg-slate-200/70 p-0.5 text-xs">
              <button
                onClick={() => void handleToggleMobileFilter(true)}
                className={`px-2.5 py-1 rounded-lg font-medium transition ${
                  filterRecent24h ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'
                }`}
              >
                24h
              </button>
              <button
                onClick={() => void handleToggleMobileFilter(false)}
                className={`px-2.5 py-1 rounded-lg font-medium transition ${
                  !filterRecent24h ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'
                }`}
              >
                Tất cả
              </button>
            </div>
          </div>
        )}

        {!watchedFolderSelected ? (
          <div className="bg-white rounded-2xl border border-slate-200/80 p-8 text-center space-y-2">
            <FileVideo className="w-6 h-6 text-slate-300 mx-auto" />
            <p className="text-xs text-slate-500">Chưa chọn thư mục trên máy tính</p>
          </div>
        ) : videos.length === 0 ? (
          <div className="bg-white rounded-2xl border border-slate-200/80 p-8 text-center space-y-3">
            <FileVideo className="w-6 h-6 text-slate-300 mx-auto" />
            <p className="text-xs text-slate-500">
              {filterRecent24h ? 'Chưa có video mới trong 24h' : 'Chưa có video'}
            </p>
            {filterRecent24h && hiddenOlderCount > 0 && (
              <button
                onClick={() => void handleToggleMobileFilter(false)}
                className="py-2 px-4 rounded-xl bg-slate-100 text-slate-700 text-xs font-semibold"
              >
                Xem {hiddenOlderCount} video cũ hơn
              </button>
            )}
          </div>
        ) : (
          videos.map((video) => (
            <MobileVideoCard
              key={video.id}
              video={video}
              onPreview={() => {
                setPreviewCodecError(false);
                setPreviewVideo(video);
              }}
              onDownloadTap={handleDownloadTap}
              onConfirmPhotos={() => void handleConfirmSavedToPhotos(video.id)}
            />
          ))
        )}
      </main>

      {/* Video Preview Modal */}
      {previewVideo && (
        <div className="fixed inset-0 z-40 bg-slate-950/80 backdrop-blur-sm flex items-end sm:items-center justify-center p-3">
          <div className="bg-slate-900 text-white w-full max-w-lg rounded-3xl overflow-hidden shadow-xl border border-slate-800">
            <div className="px-4 py-3 flex items-center justify-between border-b border-slate-800">
              <p className="text-xs font-medium truncate pr-3">{previewVideo.fileName}</p>
              <button
                onClick={() => setPreviewVideo(null)}
                className="p-1.5 rounded-full bg-slate-800 text-slate-300"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="bg-black aspect-[9/14] max-h-[65vh] w-full flex items-center justify-center">
              {!previewCodecError ? (
                <video
                  src={previewVideo.previewUrl}
                  controls
                  playsInline
                  autoPlay
                  preload="metadata"
                  onError={() => setPreviewCodecError(true)}
                  className="w-full h-full object-contain"
                />
              ) : (
                <div className="p-6 text-center space-y-2">
                  <AlertCircle className="w-6 h-6 text-amber-400 mx-auto" />
                  <p className="text-xs text-slate-300">
                    Không phát trực tiếp được định dạng này — hãy bấm Lưu vào Ảnh bên dưới.
                  </p>
                </div>
              )}
            </div>

            <div className="p-3.5 flex gap-2 bg-slate-900">
              <a
                href={previewVideo.shortcutSaveUrl}
                onClick={() => {
                  handleDownloadTap();
                  setPreviewVideo(null);
                }}
                className="flex-1 py-3 rounded-xl bg-emerald-600 text-white text-xs font-semibold flex items-center justify-center gap-1.5"
              >
                <Zap className="w-4 h-4" />
                Lưu vào Ảnh
              </a>
              <a
                href={previewVideo.downloadUrl}
                download={previewVideo.iosDownloadFileName}
                onClick={() => {
                  handleDownloadTap();
                  setPreviewVideo(null);
                }}
                className="py-3 px-4 rounded-xl bg-slate-800 text-slate-200 text-xs font-medium flex items-center justify-center gap-1.5"
              >
                <Download className="w-4 h-4" />
                Safari
              </a>
            </div>
          </div>
        </div>
      )}

      {/* Clean Apple Shortcut Setup Modal */}
      {showShortcutGuideModal && (
        <div className="fixed inset-0 z-40 bg-slate-950/50 backdrop-blur-sm flex items-end sm:items-center justify-center p-4">
          <div className="bg-white w-full max-w-md rounded-3xl p-5 space-y-4 shadow-xl">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-slate-900">Cài Phím tắt 1 chạm</h2>
              <button
                onClick={() => setShowShortcutGuideModal(false)}
                className="p-1 rounded-full bg-slate-100 text-slate-500"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {icloudShortcutUrl && (
              <a
                href={icloudShortcutUrl}
                target="_blank"
                rel="noreferrer"
                className="w-full py-2.5 px-4 rounded-xl bg-emerald-600 text-white text-xs font-semibold flex items-center justify-center gap-1.5"
              >
                <ExternalLink className="w-3.5 h-3.5" />
                Tải Phím tắt từ iCloud
              </a>
            )}

            <div className="p-3.5 rounded-2xl bg-slate-50 border border-slate-200/80 text-xs text-slate-600 space-y-2.5 leading-relaxed">
              <div className="flex items-center justify-between">
                <span>
                  1. Tạo phím tắt tên <strong className="text-slate-900">Ecom Video Drop</strong>
                </span>
                <button
                  type="button"
                  onClick={() => void handleCopyShortcutName()}
                  className="inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-white border border-slate-200 text-slate-700 font-medium text-[11px]"
                >
                  {copiedShortcutName ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                  {copiedShortcutName ? 'Đã chép' : 'Chép tên'}
                </button>
              </div>
              <p>
                2. Thêm 3 lệnh: <strong>Lấy các URL từ Đầu vào Phím tắt</strong> &rarr;{' '}
                <strong>Lấy nội dung của URL</strong> &rarr; <strong>Lưu vào Album ảnh</strong>.
              </p>
              <p>3. Chọn <strong>Luôn cho phép</strong> ở lần chạy đầu tiên.</p>
            </div>

            <button
              onClick={() => setShowShortcutGuideModal(false)}
              className="w-full py-2.5 rounded-xl bg-slate-900 text-white text-xs font-semibold"
            >
              Đóng
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

const MobileVideoCard: React.FC<{
  video: MobileVideoItem;
  onPreview: () => void;
  onDownloadTap: () => void;
  onConfirmPhotos: () => void;
}> = ({ video, onPreview, onDownloadTap, onConfirmPhotos }) => {
  const isWaiting = video.status === 'waiting_complete';
  const isInvalid = video.status === 'invalid';
  const isTransferring = video.status === 'transferring';
  const isDownloadedSafari = video.status === 'downloaded_to_safari';
  const isSavedPhotos = video.status === 'saved_to_photos';

  return (
    <div className="bg-white rounded-2xl border border-slate-200/80 shadow-[0_1px_2px_rgba(15,23,42,0.03)] p-3.5 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-[13.5px] font-medium text-slate-900 break-words leading-snug">
            {video.fileName}
          </p>
          <div className="flex items-center gap-1.5 text-xs text-slate-400 mt-1">
            <span className="uppercase font-semibold text-slate-500">{video.extension}</span>
            <span>•</span>
            <span>{formatFileSize(video.sizeBytes)}</span>
            <span>•</span>
            <span>{formatClockTime(video.modifiedAtMs)}</span>
          </div>
        </div>

        {isSavedPhotos && (
          <span className="shrink-0 inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-emerald-50 text-emerald-700">
            <CheckCircle2 className="w-3 h-3" />
            Đã lưu
          </span>
        )}
      </div>

      {isWaiting && (
        <div className="text-xs text-amber-700 flex items-center gap-1.5">
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
          <span>Đang tải xong trên máy tính...</span>
        </div>
      )}

      {isInvalid && <p className="text-xs text-rose-600">File lỗi</p>}

      {isTransferring && (
        <div className="space-y-1">
          <div className="h-1.5 w-full bg-slate-100 rounded-full overflow-hidden">
            <div
              className="h-full bg-emerald-500 transition-all duration-150"
              style={{ width: `${video.transferPercent}%` }}
            />
          </div>
          <p className="text-[11px] text-slate-500 text-right">{video.transferPercent}%</p>
        </div>
      )}

      {video.errorMessage && <p className="text-xs text-rose-600">{video.errorMessage}</p>}

      {isDownloadedSafari && (
        <div className="p-2.5 rounded-xl bg-sky-50 border border-sky-100 flex items-center justify-between gap-2 text-xs text-sky-900">
          <span>
            Mở mục <strong>↓</strong> Safari &rarr; <Share className="w-3 h-3 inline -mt-0.5" />{' '}
            <strong>Lưu video</strong>
          </span>
          <button
            onClick={onConfirmPhotos}
            className="px-2.5 py-1.5 rounded-lg bg-emerald-600 text-white font-semibold shrink-0"
          >
            Đã lưu ✓
          </button>
        </div>
      )}

      {!isWaiting && !isInvalid && (
        <div className="flex items-center gap-2">
          <a
            href={video.shortcutSaveUrl}
            onClick={onDownloadTap}
            className={`flex-1 py-2.5 px-3 rounded-xl text-xs font-semibold flex items-center justify-center gap-1.5 ${
              isSavedPhotos
                ? 'border border-slate-200 text-slate-700'
                : 'bg-emerald-600 text-white shadow-sm active:bg-emerald-700'
            }`}
          >
            <Zap className="w-3.5 h-3.5" />
            {isSavedPhotos ? 'Lưu lại' : 'Lưu vào Ảnh'}
          </a>

          <button
            onClick={onPreview}
            className="py-2.5 px-3 rounded-xl border border-slate-200 text-slate-600 text-xs font-medium flex items-center gap-1 active:bg-slate-50"
          >
            <Play className="w-3.5 h-3.5" />
            Xem
          </button>

          <a
            href={video.downloadUrl}
            download={video.iosDownloadFileName}
            onClick={onDownloadTap}
            className="py-2.5 px-3 rounded-xl border border-slate-200 text-slate-600 text-xs font-medium flex items-center gap-1 active:bg-slate-50"
            title="Tải qua Safari"
          >
            <Download className="w-3.5 h-3.5" />
          </a>
        </div>
      )}
    </div>
  );
};
