import React, { useEffect, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  ExternalLink,
  FileVideo,
  FolderOpen,
  HelpCircle,
  Loader2,
  RefreshCw,
  Send,
  Settings,
  Smartphone,
  Unplug,
  Wifi,
  X,
  Zap
} from 'lucide-react';
import { DesktopAppState, VideoItem } from '../shared/types';
import appIconUrl from '../shared/appIcon.png';
import {
  formatClockTime,
  formatFileSize,
  formatPinDisplay,
  formatRemainingDuration
} from '../shared/formatters';

type ConnectTab = 'airdrop' | 'safari';

export const App: React.FC = () => {
  const [state, setState] = useState<DesktopAppState | null>(null);
  const [activeTab, setActiveTab] = useState<ConnectTab>('airdrop');
  const [showSettingsModal, setShowSettingsModal] = useState(false);
  const [showHelpModal, setShowHelpModal] = useState(false);
  const [showReopenQr, setShowReopenQr] = useState(false);
  const [manualIpInput, setManualIpInput] = useState('');
  const [pinDraft, setPinDraft] = useState('');
  const [shortcutUrlDraft, setShortcutUrlDraft] = useState('');
  const [busyAction, setBusyAction] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    void window.ecomVideoDrop.getState().then((initial) => {
      if (!mounted) return;
      setState(initial);
      setPinDraft(initial.localSend.pin ?? '');
      setShortcutUrlDraft(initial.icloudShortcutUrl ?? '');
    });

    const unsubscribe = window.ecomVideoDrop.onStateChanged((next) => {
      if (mounted) setState(next);
    });

    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);

  if (!state) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#F8FAFC] text-slate-500 text-sm">
        <Loader2 className="w-5 h-5 animate-spin mr-2 text-indigo-600" />
        <span>Đang khởi động...</span>
      </div>
    );
  }

  const { pairing, localSend, videos, watchedFolder, filterRecent24h, hiddenOlderCount } = state;

  // Avoid showing duplicate error in sidebar if a video row already displays it
  const isErrorShownOnVideoRow =
    Boolean(localSend.lastPushError) &&
    videos.some((v) => v.errorMessage === localSend.lastPushError);

  const handleSelectFolder = async () => {
    setBusyAction('folder');
    try {
      const next = await window.ecomVideoDrop.selectFolder();
      setState(next);
    } finally {
      setBusyAction(null);
    }
  };

  const handleToggleFilter = async (recent24h: boolean) => {
    const next = await window.ecomVideoDrop.setFilterRecent24h(recent24h);
    setState(next);
  };

  const handleSelectInterface = async (address: string) => {
    setBusyAction('network');
    try {
      const next = await window.ecomVideoDrop.selectNetworkInterface(address);
      setState(next);
    } finally {
      setBusyAction(null);
    }
  };

  const handleRefreshNetwork = async () => {
    setBusyAction('network');
    try {
      const next = await window.ecomVideoDrop.refreshNetwork();
      setState(next);
    } finally {
      setBusyAction(null);
    }
  };

  const handleRotateCredentials = async () => {
    const next = await window.ecomVideoDrop.rotatePairingCredentials();
    setState(next);
  };

  const handleDisconnectDevice = async () => {
    const next = await window.ecomVideoDrop.disconnectPairedDevice();
    setShowReopenQr(false);
    setState(next);
  };

  const handleScanLocalSend = async () => {
    const next = await window.ecomVideoDrop.scanLocalSendPeers();
    setState(next);
  };

  const handleSelectLocalSendPeer = async (fingerprint: string) => {
    const next = await window.ecomVideoDrop.selectLocalSendPeer(fingerprint || null);
    setState(next);
  };

  const handleToggleAutoPush = async () => {
    const next = await window.ecomVideoDrop.setLocalSendAutoPush(!localSend.autoPushNewVideos);
    setState(next);
  };

  const handleConnectManualIp = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!manualIpInput.trim()) return;
    setBusyAction('manual-ip');
    try {
      const next = await window.ecomVideoDrop.addManualLocalSendPeer(manualIpInput.trim());
      setState(next);
      if (next.localSend.selectedPeer) {
        setManualIpInput('');
        setShowSettingsModal(false);
      }
    } finally {
      setBusyAction(null);
    }
  };

  const handleSaveSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    await window.ecomVideoDrop.setLocalSendPin(pinDraft);
    const next = await window.ecomVideoDrop.setIcloudShortcutUrl(shortcutUrlDraft);
    setState(next);
    setShortcutUrlDraft(next.icloudShortcutUrl ?? '');
    setShowSettingsModal(false);
  };

  const handlePushVideo = async (videoId: string) => {
    if (!localSend.selectedPeer) {
      setActiveTab('airdrop');
    }
    const next = await window.ecomVideoDrop.pushVideoViaLocalSend(videoId);
    setState(next);
  };

  return (
    <div className="min-h-screen bg-[#F8FAFC] text-slate-900 flex flex-col select-none">
      {/* Minimalist Top Bar */}
      <header className="h-14 bg-white border-b border-slate-200/80 px-6 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-3">
          <img src={appIconUrl} alt="Ecom Video Drop" className="w-8 h-8 object-contain" />
          <span className="text-[15px] font-semibold tracking-tight text-slate-900">
            Ecom Video Drop
          </span>
          <button
            onClick={() => setShowSettingsModal(true)}
            className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium transition ${
              pairing.serverRunning
                ? 'bg-slate-100 text-slate-600 hover:bg-slate-200/70'
                : 'bg-rose-50 text-rose-700'
            }`}
            title="Cấu hình mạng LAN"
          >
            <span
              className={`w-1.5 h-1.5 rounded-full ${
                pairing.serverRunning ? 'bg-emerald-500' : 'bg-rose-500'
              }`}
            />
            {pairing.serverRunning && pairing.lanIp ? pairing.lanIp : 'Chưa có mạng'}
          </button>
        </div>

        <div className="flex items-center gap-1.5">
          <button
            onClick={() => setShowSettingsModal(true)}
            className="inline-flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-xl text-slate-600 hover:text-slate-900 hover:bg-slate-100 transition"
          >
            <Settings className="w-4 h-4" />
            Cài đặt
          </button>
          <button
            onClick={() => setShowHelpModal(true)}
            className="inline-flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-xl text-slate-600 hover:text-slate-900 hover:bg-slate-100 transition"
          >
            <HelpCircle className="w-4 h-4" />
            Hướng dẫn
          </button>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 max-w-6xl w-full mx-auto p-5 grid grid-cols-12 gap-5">
        {/* Left Column: Clean Device Connection Card */}
        <section className="col-span-12 lg:col-span-4">
          <div className="bg-white rounded-2xl border border-slate-200/80 shadow-[0_1px_3px_rgba(15,23,42,0.03)] p-4 space-y-4">
            {/* Segmented Mode Control */}
            <div className="bg-slate-100 p-1 rounded-xl grid grid-cols-2 gap-1 text-xs font-semibold">
              <button
                onClick={() => setActiveTab('airdrop')}
                className={`py-2 px-3 rounded-lg flex items-center justify-center gap-1.5 transition ${
                  activeTab === 'airdrop'
                    ? 'bg-white text-slate-900 shadow-sm'
                    : 'text-slate-500 hover:text-slate-800'
                }`}
              >
                <Zap className="w-3.5 h-3.5 text-emerald-600" />
                <span>AirDrop</span>
                {localSend.selectedPeer && (
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                )}
              </button>
              <button
                onClick={() => setActiveTab('safari')}
                className={`py-2 px-3 rounded-lg flex items-center justify-center gap-1.5 transition ${
                  activeTab === 'safari'
                    ? 'bg-white text-slate-900 shadow-sm'
                    : 'text-slate-500 hover:text-slate-800'
                }`}
              >
                <Smartphone className="w-3.5 h-3.5 text-indigo-600" />
                <span>QR Safari</span>
                {pairing.pairedDevice && (
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                )}
              </button>
            </div>

            {activeTab === 'airdrop' ? (
              <div className="space-y-3.5 pt-0.5">
                {/* Device Dropdown + Refresh Icon */}
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium text-slate-500">iPhone nhận</span>
                    <button
                      onClick={() => void handleScanLocalSend()}
                      disabled={localSend.scanning}
                      className="inline-flex items-center gap-1 text-xs font-medium text-emerald-700 hover:text-emerald-800 disabled:opacity-50"
                    >
                      <RefreshCw
                        className={`w-3.5 h-3.5 ${localSend.scanning ? 'animate-spin' : ''}`}
                      />
                      {localSend.scanning ? 'Đang quét' : 'Quét lại'}
                    </button>
                  </div>

                  {localSend.discoveredPeers.length > 0 ? (
                    <select
                      value={localSend.selectedPeer?.fingerprint ?? ''}
                      onChange={(e) => void handleSelectLocalSendPeer(e.target.value)}
                      className="w-full text-[13px] bg-slate-50 hover:bg-slate-100/70 border border-slate-200 rounded-xl px-3 py-2.5 text-slate-900 font-medium focus:outline-none focus:ring-2 focus:ring-emerald-500/30 focus:border-emerald-500 transition"
                    >
                      <option value="">Chọn iPhone...</option>
                      {localSend.discoveredPeers.map((peer) => (
                        <option key={peer.fingerprint} value={peer.fingerprint}>
                          {peer.alias} • {peer.ip}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <div className="px-3.5 py-3 rounded-xl bg-slate-50 border border-dashed border-slate-200 flex items-center justify-between gap-2">
                      <span className="text-xs text-slate-500">Mở LocalSend trên iPhone</span>
                      <button
                        onClick={() => void handleScanLocalSend()}
                        disabled={localSend.scanning}
                        className="text-xs font-semibold text-emerald-700 hover:underline shrink-0"
                      >
                        Tìm ngay
                      </button>
                    </div>
                  )}
                </div>

                {/* Clean iOS Switch Row for Auto-Push */}
                <div
                  onClick={() => void handleToggleAutoPush()}
                  className="flex items-center justify-between px-3.5 py-3 rounded-xl bg-slate-50 hover:bg-slate-100/70 border border-slate-200/80 cursor-pointer transition"
                >
                  <div>
                    <p className="text-[13px] font-medium text-slate-900">Tự động gửi video mới</p>
                    <p className="text-[11px] text-slate-500">Lưu thẳng vào Ảnh khi tải xong</p>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={localSend.autoPushNewVideos}
                    className={`relative inline-flex h-6 w-10 shrink-0 rounded-full transition-colors duration-200 ${
                      localSend.autoPushNewVideos ? 'bg-emerald-500' : 'bg-slate-300'
                    }`}
                  >
                    <span
                      className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition duration-200 mt-0.5 ${
                        localSend.autoPushNewVideos ? 'translate-x-[18px]' : 'translate-x-0.5'
                      }`}
                    />
                  </button>
                </div>

                {/* Non-duplicated Peer Notice */}
                {localSend.lastPushError && !isErrorShownOnVideoRow && (
                  <div className="px-3 py-2.5 rounded-xl bg-rose-50 border border-rose-200/80 text-xs text-rose-700 flex items-start gap-2">
                    <AlertCircle className="w-4 h-4 text-rose-500 shrink-0 mt-0.5" />
                    <span>{localSend.lastPushError}</span>
                  </div>
                )}

                {/* Subtle Single-Line Footer Action */}
                <div className="pt-1 flex items-center justify-between text-[11px] text-slate-400">
                  <button
                    onClick={() => setShowSettingsModal(true)}
                    className="hover:text-slate-600 transition"
                  >
                    Nhập IP thủ công
                  </button>
                  <button
                    onClick={() => setShowHelpModal(true)}
                    className="hover:text-emerald-700 transition"
                  >
                    Cách bật Lưu nhanh 0 chạm &rarr;
                  </button>
                </div>
              </div>
            ) : (
              /* QR SAFARI MODE */
              <div className="space-y-3.5 pt-0.5">
                {pairing.serverError && (
                  <div className="px-3 py-2.5 rounded-xl bg-rose-50 border border-rose-200 text-xs text-rose-700">
                    {pairing.serverError}
                  </div>
                )}

                {pairing.pairedDevice ? (
                  <div className="space-y-3">
                    <div className="p-3.5 rounded-xl bg-emerald-50/70 border border-emerald-200/80 space-y-2">
                      <div className="flex items-center justify-between">
                        <span className="text-[13px] font-semibold text-slate-900">
                          {pairing.pairedDevice.deviceLabel}
                        </span>
                        <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                      </div>
                      <div className="flex items-center justify-between text-xs text-slate-600">
                        <span className="font-mono">{pairing.pairedDevice.ipAddress}</span>
                        <span>Còn {formatRemainingDuration(pairing.pairedDevice.expiresAtMs)}</span>
                      </div>
                    </div>

                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => setShowReopenQr((v) => !v)}
                        className="flex-1 text-xs font-medium py-2 rounded-xl border border-slate-200 text-slate-700 hover:bg-slate-50 transition"
                      >
                        {showReopenQr ? 'Ẩn QR' : 'Hiện QR'}
                      </button>
                      <button
                        onClick={handleDisconnectDevice}
                        className="inline-flex items-center justify-center gap-1.5 text-xs font-medium px-3.5 py-2 rounded-xl bg-rose-50 text-rose-700 hover:bg-rose-100 transition"
                      >
                        <Unplug className="w-3.5 h-3.5" />
                        Ngắt
                      </button>
                    </div>

                    {showReopenQr && pairing.qrDataUrl && (
                      <div className="pt-1 flex justify-center">
                        <img
                          src={pairing.qrDataUrl}
                          alt="QR Safari"
                          className="w-36 h-36 rounded-xl border border-slate-200 p-1.5 bg-white"
                        />
                      </div>
                    )}
                  </div>
                ) : (
                  pairing.serverRunning && (
                    <div className="space-y-3">
                      <div className="flex flex-col items-center bg-slate-50 rounded-xl p-3.5 border border-slate-200/60">
                        {pairing.qrDataUrl ? (
                          <img
                            src={pairing.qrDataUrl}
                            alt="QR kết nối iPhone"
                            className="w-44 h-44 rounded-xl bg-white p-1.5 border border-slate-200/80"
                          />
                        ) : (
                          <div className="w-44 h-44 flex items-center justify-center text-xs text-slate-400">
                            Đang tạo QR...
                          </div>
                        )}
                      </div>

                      <div className="flex items-center justify-between px-3.5 py-2.5 rounded-xl bg-indigo-50/60 border border-indigo-100">
                        <span className="text-xs font-medium text-indigo-900">Mã PIN</span>
                        <span className="font-mono text-lg font-bold tracking-[0.2em] text-indigo-950">
                          {formatPinDisplay(pairing.pinCode)}
                        </span>
                        <button
                          onClick={handleRotateCredentials}
                          title="Đổi mã PIN mới"
                          className="p-1 rounded-lg text-indigo-600 hover:bg-indigo-100 transition"
                        >
                          <RefreshCw className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  )
                )}
              </div>
            )}
          </div>
        </section>

        {/* Right Column: Compact Folder Bar + Clean Video List */}
        <section className="col-span-12 lg:col-span-8 flex flex-col gap-4">
          {/* Sleek Single-Row Watched Folder Bar */}
          <div className="bg-white rounded-2xl border border-slate-200/80 shadow-[0_1px_3px_rgba(15,23,42,0.03)] px-4 py-3 flex items-center justify-between gap-3">
            <div className="flex items-center gap-3 min-w-0 flex-1">
              <div className="w-9 h-9 rounded-xl bg-indigo-50 text-indigo-600 flex items-center justify-center shrink-0">
                <FolderOpen className="w-4 h-4" />
              </div>
              <div className="min-w-0 flex-1">
                {watchedFolder ? (
                  <p
                    title={watchedFolder}
                    className="text-[13px] font-medium text-slate-800 truncate font-mono"
                  >
                    {watchedFolder}
                  </p>
                ) : (
                  <p className="text-[13px] text-slate-400">Chưa chọn thư mục chứa video</p>
                )}
                {state.activeBrowserDownloadsCount > 0 && (
                  <p className="text-[11px] text-indigo-600 font-medium flex items-center gap-1 mt-0.5">
                    <Loader2 className="w-3 h-3 animate-spin" />
                    Đang tải {state.activeBrowserDownloadsCount} file từ trình duyệt...
                  </p>
                )}
              </div>
            </div>

            <div className="flex items-center gap-1.5 shrink-0">
              {watchedFolder && (
                <button
                  onClick={() => void window.ecomVideoDrop.openWatchedFolderInExplorer()}
                  title="Mở thư mục"
                  className="p-2 rounded-xl text-slate-500 hover:text-slate-800 hover:bg-slate-100 transition"
                >
                  <ExternalLink className="w-4 h-4" />
                </button>
              )}
              <button
                onClick={handleSelectFolder}
                disabled={busyAction === 'folder'}
                className="text-xs font-semibold px-3.5 py-2 rounded-xl bg-slate-900 text-white hover:bg-slate-800 transition"
              >
                {watchedFolder ? 'Đổi thư mục' : 'Chọn thư mục'}
              </button>
            </div>
          </div>

          {/* Clean Video List Card */}
          <div className="bg-white rounded-2xl border border-slate-200/80 shadow-[0_1px_3px_rgba(15,23,42,0.03)] flex-1 flex flex-col overflow-hidden min-h-[420px]">
            <div className="px-5 py-3 border-b border-slate-100 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <h2 className="text-[13px] font-semibold text-slate-900">Video</h2>
                <span className="px-2 py-0.5 rounded-full text-[11px] font-semibold bg-slate-100 text-slate-600">
                  {videos.length}
                </span>
                {hiddenOlderCount > 0 && filterRecent24h && (
                  <button
                    onClick={() => void handleToggleFilter(false)}
                    className="text-xs text-indigo-600 hover:underline ml-1"
                  >
                    +{hiddenOlderCount} cũ hơn
                  </button>
                )}
              </div>

              <div className="inline-flex rounded-lg bg-slate-100 p-0.5 text-xs">
                <button
                  onClick={() => void handleToggleFilter(true)}
                  className={`px-2.5 py-1 rounded-md font-medium transition ${
                    filterRecent24h
                      ? 'bg-white text-slate-900 shadow-sm'
                      : 'text-slate-500 hover:text-slate-800'
                  }`}
                >
                  24h
                </button>
                <button
                  onClick={() => void handleToggleFilter(false)}
                  className={`px-2.5 py-1 rounded-md font-medium transition ${
                    !filterRecent24h
                      ? 'bg-white text-slate-900 shadow-sm'
                      : 'text-slate-500 hover:text-slate-800'
                  }`}
                >
                  Tất cả
                </button>
              </div>
            </div>

            {!watchedFolder ? (
              <div className="flex-1 flex flex-col items-center justify-center p-10 text-center">
                <div className="w-11 h-11 rounded-2xl bg-slate-100 text-slate-400 flex items-center justify-center mb-3">
                  <FolderOpen className="w-5 h-5" />
                </div>
                <p className="text-sm font-medium text-slate-700">Chọn thư mục để bắt đầu</p>
                <button
                  onClick={handleSelectFolder}
                  className="mt-3 text-xs font-semibold px-4 py-2 rounded-xl bg-indigo-600 text-white hover:bg-indigo-700 transition"
                >
                  Chọn thư mục
                </button>
              </div>
            ) : videos.length === 0 ? (
              <div className="flex-1 flex flex-col items-center justify-center p-10 text-center">
                <div className="w-11 h-11 rounded-2xl bg-slate-100 text-slate-400 flex items-center justify-center mb-3">
                  <FileVideo className="w-5 h-5" />
                </div>
                <p className="text-sm font-medium text-slate-700">
                  {filterRecent24h ? 'Chưa có video mới trong 24h' : 'Thư mục chưa có video'}
                </p>
                {filterRecent24h && hiddenOlderCount > 0 && (
                  <button
                    onClick={() => void handleToggleFilter(false)}
                    className="mt-3 text-xs font-semibold px-3.5 py-2 rounded-xl bg-slate-100 text-slate-700 hover:bg-slate-200 transition"
                  >
                    Xem {hiddenOlderCount} video cũ hơn
                  </button>
                )}
              </div>
            ) : (
              <div className="divide-y divide-slate-100 overflow-y-auto max-h-[520px]">
                {videos.map((video) => (
                  <VideoRow
                    key={video.id}
                    video={video}
                    isPushingThis={localSend.activePushVideoId === video.id}
                    onPushViaLocalSend={() => void handlePushVideo(video.id)}
                  />
                ))}
              </div>
            )}
          </div>
        </section>
      </main>

      {/* Clean Settings Modal (Network, Manual IP, PIN, Shortcut Link) */}
      {showSettingsModal && (
        <div className="fixed inset-0 z-40 bg-slate-900/40 backdrop-blur-[2px] flex items-center justify-center p-4">
          <div className="bg-white w-full max-w-md rounded-2xl border border-slate-200 shadow-xl p-5 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-slate-900">Cài đặt kết nối</h3>
              <button
                onClick={() => setShowSettingsModal(false)}
                className="p-1 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* LAN Interface */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <label className="text-xs font-medium text-slate-600 flex items-center gap-1.5">
                  <Wifi className="w-3.5 h-3.5 text-slate-400" />
                  Card mạng Wi-Fi / LAN
                </label>
                <button
                  type="button"
                  onClick={() => void handleRefreshNetwork()}
                  className="text-xs text-indigo-600 hover:underline"
                >
                  Làm mới
                </button>
              </div>
              {pairing.availableInterfaces.length > 0 ? (
                <select
                  value={pairing.lanIp ?? ''}
                  onChange={(e) => void handleSelectInterface(e.target.value)}
                  className="w-full text-xs bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-slate-800 font-medium focus:outline-none focus:ring-2 focus:ring-indigo-500/30"
                >
                  {pairing.availableInterfaces.map((iface) => (
                    <option key={`${iface.name}-${iface.address}`} value={iface.address}>
                      {iface.name} — {iface.address}
                    </option>
                  ))}
                </select>
              ) : (
                <p className="text-xs text-slate-400">Chưa phát hiện mạng nội bộ</p>
              )}
            </div>

            {/* Manual IP Connect */}
            <form onSubmit={handleConnectManualIp} className="space-y-1.5 pt-2 border-t border-slate-100">
              <label className="block text-xs font-medium text-slate-600">
                Kết nối IP iPhone thủ công (LocalSend)
              </label>
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  placeholder="Ví dụ: 192.168.1.25"
                  value={manualIpInput}
                  onChange={(e) => setManualIpInput(e.target.value)}
                  className="flex-1 text-xs bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 font-mono focus:outline-none focus:ring-2 focus:ring-emerald-500/30"
                />
                <button
                  type="submit"
                  disabled={busyAction === 'manual-ip'}
                  className="text-xs font-semibold px-3.5 py-2 rounded-xl bg-emerald-600 text-white hover:bg-emerald-700"
                >
                  Kết nối
                </button>
              </div>
            </form>

            {/* Optional PIN & iCloud Shortcut */}
            <form onSubmit={handleSaveSettings} className="space-y-3 pt-2 border-t border-slate-100">
              <div className="space-y-1">
                <label className="block text-xs font-medium text-slate-600">
                  Mã PIN LocalSend (nếu bật trên iPhone)
                </label>
                <input
                  type="text"
                  placeholder="Để trống nếu không dùng"
                  value={pinDraft}
                  onChange={(e) => setPinDraft(e.target.value)}
                  className="w-full text-xs bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 font-mono focus:outline-none focus:ring-2 focus:ring-indigo-500/30"
                />
              </div>

              <div className="space-y-1">
                <label className="block text-xs font-medium text-slate-600">
                  Link iCloud Phím tắt (tùy chọn cho chế độ QR Safari)
                </label>
                <input
                  type="url"
                  placeholder="https://www.icloud.com/shortcuts/..."
                  value={shortcutUrlDraft}
                  onChange={(e) => setShortcutUrlDraft(e.target.value)}
                  className="w-full text-xs bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-500/30"
                />
              </div>

              <div className="flex justify-end gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => setShowSettingsModal(false)}
                  className="text-xs font-medium px-3.5 py-2 rounded-xl text-slate-600 hover:bg-slate-100"
                >
                  Đóng
                </button>
                <button
                  type="submit"
                  className="text-xs font-semibold px-4 py-2 rounded-xl bg-slate-900 text-white hover:bg-slate-800"
                >
                  Lưu thay đổi
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Clean Quick Guide Modal */}
      {showHelpModal && (
        <div className="fixed inset-0 z-40 bg-slate-900/40 backdrop-blur-[2px] flex items-center justify-center p-4">
          <div className="bg-white w-full max-w-md rounded-2xl border border-slate-200 shadow-xl p-5 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-slate-900">Hướng dẫn nhanh</h3>
              <button
                onClick={() => setShowHelpModal(false)}
                className="p-1 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-3 text-xs text-slate-600 leading-relaxed">
              <div className="p-3.5 rounded-xl bg-emerald-50/70 border border-emerald-200/70 space-y-1">
                <p className="font-semibold text-emerald-950">
                  1. Tự lưu vào Ảnh 0 chạm (LocalSend)
                </p>
                <p>
                  Mở app <strong>LocalSend</strong> trên iPhone &rarr; tab <strong>Cài đặt</strong> &rarr; bật{' '}
                  <strong>Lưu nhanh (Quick Save)</strong> và <strong>Lưu media vào thư viện ảnh</strong>. Khi nhận hãy để mở tab <strong>Nhận</strong>.
                </p>
              </div>

              <div className="p-3.5 rounded-xl bg-slate-50 border border-slate-200/80 space-y-1">
                <p className="font-semibold text-slate-900">
                  2. Nếu máy tính và iPhone không thấy nhau
                </p>
                <p>
                  Đảm bảo cả 2 máy bắt <strong>cùng một Wi-Fi</strong> (tắt VPN/WARP). Trên Windows lần đầu mở, tích chọn cả <strong>Private</strong> &amp; <strong>Public networks</strong> khi bảng Firewall hỏi quyền.
                </p>
              </div>
            </div>

            <button
              onClick={() => setShowHelpModal(false)}
              className="w-full py-2 rounded-xl bg-slate-900 text-white text-xs font-semibold"
            >
              Đã hiểu
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

const VideoRow: React.FC<{
  video: VideoItem;
  isPushingThis: boolean;
  onPushViaLocalSend: () => void;
}> = ({ video, isPushingThis, onPushViaLocalSend }) => {
  const isWaiting = video.status === 'waiting_complete';
  const isInvalid = video.status === 'invalid';
  const isTransferring = video.status === 'transferring' || isPushingThis;
  const isSaved = video.status === 'saved_to_photos';
  const isSafari = video.status === 'downloaded_to_safari';

  return (
    <div className="px-5 py-3.5 hover:bg-slate-50/70 transition flex items-center justify-between gap-4">
      <div className="min-w-0 flex items-center gap-3 flex-1">
        <div className="w-9 h-9 rounded-xl bg-slate-100 text-slate-600 flex items-center justify-center shrink-0 font-bold text-[10px] uppercase tracking-wide">
          {video.extension}
        </div>

        <div className="min-w-0 flex-1">
          <p title={video.fileName} className="text-[13.5px] font-medium text-slate-900 truncate">
            {video.fileName}
          </p>

          <div className="flex items-center gap-2 text-xs text-slate-400 mt-0.5">
            <span>{formatFileSize(video.sizeBytes)}</span>
            <span>•</span>
            <span>{formatClockTime(video.modifiedAtMs)}</span>
            {video.needsIosRemux && (
              <>
                <span>•</span>
                <span className="text-indigo-600 font-medium">Tự đổi MP4</span>
              </>
            )}
          </div>

          {video.status === 'transferring' && (
            <div className="mt-2 w-full max-w-xs flex items-center gap-2">
              <div className="h-1.5 flex-1 bg-slate-100 rounded-full overflow-hidden">
                <div
                  className="h-full bg-emerald-500 transition-all duration-150"
                  style={{ width: `${video.transferPercent}%` }}
                />
              </div>
              <span className="text-[11px] font-medium text-emerald-700">
                {video.transferPercent}%
              </span>
            </div>
          )}

          {video.errorMessage && (
            <p className="text-xs text-rose-600 mt-1">{video.errorMessage}</p>
          )}
        </div>
      </div>

      <div className="shrink-0 flex items-center gap-2.5">
        {isWaiting && (
          <span className="inline-flex items-center gap-1.5 text-xs text-amber-700 font-medium">
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            Đang tải...
          </span>
        )}

        {isInvalid && <span className="text-xs text-rose-600 font-medium">File lỗi</span>}

        {isSaved && !isTransferring && (
          <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium bg-emerald-50 text-emerald-700">
            <CheckCircle2 className="w-3.5 h-3.5" />
            Đã lưu
          </span>
        )}

        {isSafari && !isTransferring && (
          <span className="px-2.5 py-1 rounded-full text-xs font-medium bg-sky-50 text-sky-700">
            Ở Safari
          </span>
        )}

        {!isWaiting && !isInvalid && (
          <button
            onClick={onPushViaLocalSend}
            disabled={isTransferring}
            className={`inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl text-xs font-semibold transition disabled:opacity-60 ${
              isSaved
                ? 'border border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                : 'bg-emerald-600 text-white hover:bg-emerald-700 shadow-sm'
            }`}
          >
            {isTransferring ? (
              <>
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                Đang gửi
              </>
            ) : (
              <>
                <Send className="w-3.5 h-3.5" />
                {isSaved ? 'Gửi lại' : 'Gửi'}
              </>
            )}
          </button>
        )}
      </div>
    </div>
  );
};
