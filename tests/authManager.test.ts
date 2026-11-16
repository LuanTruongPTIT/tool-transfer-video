import { describe, it, expect } from 'vitest';
import { AuthManager } from '../src/main/authManager';
import {
  isAllowedHostHeader,
  isPrivateRfc1918Ipv4,
  isSameIpv4Subnet
} from '../src/main/networkUtils';

describe('Network Isolation Utilities', () => {
  it('accepts strictly private RFC1918 IPv4 addresses and rejects public/CGNAT/link-local IPs', () => {
    expect(isPrivateRfc1918Ipv4('192.168.1.25')).toBe(true);
    expect(isPrivateRfc1918Ipv4('10.0.5.14')).toBe(true);
    expect(isPrivateRfc1918Ipv4('172.16.0.1')).toBe(true);
    expect(isPrivateRfc1918Ipv4('172.31.255.254')).toBe(true);

    expect(isPrivateRfc1918Ipv4('127.0.0.1')).toBe(false);
    expect(isPrivateRfc1918Ipv4('8.8.8.8')).toBe(false);
    expect(isPrivateRfc1918Ipv4('172.32.0.1')).toBe(false);
    expect(isPrivateRfc1918Ipv4('100.64.0.10')).toBe(false);
    expect(isPrivateRfc1918Ipv4('169.254.10.20')).toBe(false);
  });

  it('verifies same subnet mask and blocks DNS rebinding Host headers', () => {
    expect(isSameIpv4Subnet('192.168.1.10', '192.168.1.99', '255.255.255.0')).toBe(true);
    expect(isSameIpv4Subnet('192.168.1.10', '192.168.2.99', '255.255.255.0')).toBe(false);

    expect(isAllowedHostHeader('192.168.1.10:45780', '192.168.1.10', 45780)).toBe(true);
    expect(isAllowedHostHeader('attacker.com:45780', '192.168.1.10', 45780)).toBe(false);
    expect(isAllowedHostHeader('localhost:45780', '192.168.1.10', 45780)).toBe(false);
  });
});

describe('AuthManager Pairing, Rate-Limiting & 1-to-1 Device Lock', () => {
  it('enforces QR key + 6-digit PIN, locks to 1 iPhone, and invalidates tickets on disconnect', () => {
    const auth = new AuthManager({ maxPinAttempts: 3 });
    const qrKey = auth.getQrKey();
    const pinCode = auth.getPinCode();

    // Missing QR key rejected
    const noQr = auth.attemptPairing({
      qrKey: '',
      pinCode,
      remoteIp: '192.168.1.50',
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X)'
    });
    expect(noQr.ok).toBe(false);

    // Valid pairing succeeds
    const paired = auth.attemptPairing({
      qrKey,
      pinCode,
      remoteIp: '192.168.1.50',
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X)'
    });
    expect(paired.ok).toBe(true);
    if (!paired.ok) return;

    expect(auth.verifySessionToken(paired.sessionToken)?.ipAddress).toBe('192.168.1.50');

    // Second device on shared office Wi-Fi is blocked while 1-to-1 lock is active
    const secondDevice = auth.attemptPairing({
      qrKey,
      pinCode,
      remoteIp: '192.168.1.88',
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X)'
    });
    expect(secondDevice.ok).toBe(false);
    if (!secondDevice.ok) {
      expect(secondDevice.code).toBe('DEVICE_ALREADY_PAIRED');
    }

    // Media ticket works only for matching videoId and purpose
    const dlTicket = auth.createMediaTicket(paired.session.sessionId, 'vid123', 'download');
    expect(auth.verifyMediaTicket(dlTicket, 'vid123', 'download')).not.toBeNull();
    expect(auth.verifyMediaTicket(dlTicket, 'otherVid', 'download')).toBeNull();
    expect(auth.verifyMediaTicket(dlTicket, 'vid123', 'preview')).toBeNull();

    // Disconnecting on Windows immediately revokes session & media tickets
    auth.disconnectPairedDevice();
    expect(auth.verifySessionToken(paired.sessionToken)).toBeNull();
    expect(auth.verifyMediaTicket(dlTicket, 'vid123', 'download')).toBeNull();
  });

  it('auto-rotates QR key and PIN after max failed PIN attempts', () => {
    const auth = new AuthManager({ maxPinAttempts: 3 });
    const initialQr = auth.getQrKey();
    const initialPin = auth.getPinCode();
    const wrongPin = initialPin === '000000' ? '999999' : '000000';

    expect(
      auth.attemptPairing({
        qrKey: initialQr,
        pinCode: wrongPin,
        remoteIp: '192.168.1.50',
        userAgent: 'iPhone'
      }).ok
    ).toBe(false);
    expect(
      auth.attemptPairing({
        qrKey: initialQr,
        pinCode: wrongPin,
        remoteIp: '192.168.1.50',
        userAgent: 'iPhone'
      }).ok
    ).toBe(false);

    const thirdAttempt = auth.attemptPairing({
      qrKey: initialQr,
      pinCode: wrongPin,
      remoteIp: '192.168.1.50',
      userAgent: 'iPhone'
    });
    expect(thirdAttempt.ok).toBe(false);
    if (!thirdAttempt.ok) {
      expect(thirdAttempt.code).toBe('PIN_ROTATED_TOO_MANY_ATTEMPTS');
    }

    // Both QR key and PIN rotated
    expect(auth.getQrKey()).not.toBe(initialQr);
  });
});
