import { DesktopBridgeApi } from '../shared/types';

declare global {
  interface Window {
    ecomVideoDrop: DesktopBridgeApi;
  }
}
