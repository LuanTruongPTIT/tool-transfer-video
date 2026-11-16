import os from 'node:os';
import { NetworkInterfaceOption } from '../shared/types';

const VIRTUAL_ADAPTER_PATTERN =
  /vethernet|wsl|docker|vbox|vmware|virtual|hyper-v|vpn|tun|tap|utun|tailscale|zerotier|hamachi|warp|radmin|bridge|br-/i;

const PHYSICAL_PREFERRED_PATTERN = /wi-fi|wifi|wlan|en0|en1|ethernet|eth/i;

export function normalizeRemoteIpv4(rawAddress: string | undefined): string | null {
  if (!rawAddress) return null;
  const trimmed = rawAddress.trim();
  if (trimmed === '::1') return '127.0.0.1';
  if (trimmed.toLowerCase().startsWith('::ffff:')) {
    return trimmed.slice(7);
  }
  return trimmed;
}

export function ipv4ToUint32(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let result = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const num = Number(part);
    if (num < 0 || num > 255) return null;
    result = ((result << 8) | num) >>> 0;
  }
  return result >>> 0;
}

export function isPrivateRfc1918Ipv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) {
    return false;
  }
  const [a, b] = parts;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

export function isSameIpv4Subnet(ipA: string, ipB: string, netmask: string): boolean {
  const a = ipv4ToUint32(ipA);
  const b = ipv4ToUint32(ipB);
  const mask = ipv4ToUint32(netmask);
  if (a === null || b === null || mask === null) return false;
  return ((a & mask) >>> 0) === ((b & mask) >>> 0);
}

export function discoverLanInterfaces(): NetworkInterfaceOption[] {
  const nets = os.networkInterfaces();
  const options: NetworkInterfaceOption[] = [];

  for (const [name, entries] of Object.entries(nets)) {
    if (!entries) continue;
    for (const entry of entries) {
      const family = String(entry.family);
      if ((family !== 'IPv4' && family !== '4') || entry.internal) {
        continue;
      }
      if (!isPrivateRfc1918Ipv4(entry.address)) {
        continue;
      }
      const isVirtual = VIRTUAL_ADAPTER_PATTERN.test(name);
      const isPreferredPhysical = !isVirtual && PHYSICAL_PREFERRED_PATTERN.test(name);

      options.push({
        name,
        address: entry.address,
        netmask: entry.netmask || '255.255.255.0',
        cidr: entry.cidr ?? null,
        isPreferredPhysical: !isVirtual && (isPreferredPhysical || entry.address.startsWith('192.168.'))
      });
    }
  }

  options.sort((a, b) => {
    if (a.isPreferredPhysical !== b.isPreferredPhysical) {
      return a.isPreferredPhysical ? -1 : 1;
    }
    const a192 = a.address.startsWith('192.168.');
    const b192 = b.address.startsWith('192.168.');
    if (a192 !== b192) {
      return a192 ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
  });

  return options;
}

export function isAllowedHostHeader(
  hostHeader: string | undefined,
  boundIp: string,
  boundPort: number
): boolean {
  if (!hostHeader) return false;
  return hostHeader.trim().toLowerCase() === `${boundIp.toLowerCase()}:${boundPort}`;
}

export function formatFriendlyIosDeviceLabel(userAgent: string | undefined): string {
  if (!userAgent) return 'Thiết bị di động';
  if (/iPhone/i.test(userAgent)) {
    const osMatch = userAgent.match(/CPU iPhone OS (\d+)[._](\d+)/i);
    if (osMatch) {
      return `iPhone (iOS ${osMatch[1]}.${osMatch[2]} • Safari)`;
    }
    return 'iPhone (Safari)';
  }
  if (/iPad/i.test(userAgent)) {
    return 'iPad (Safari)';
  }
  if (/Macintosh/i.test(userAgent)) {
    return 'Trình duyệt trên Mac';
  }
  if (/Windows/i.test(userAgent)) {
    return 'Trình duyệt trên Windows';
  }
  return 'Thiết bị trên Wi-Fi nội bộ';
}
