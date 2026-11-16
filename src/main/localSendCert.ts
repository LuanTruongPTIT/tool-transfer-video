import crypto from 'node:crypto';

export interface LocalSendTlsIdentity {
  privateKeyPem: string;
  certificatePem: string;
  /** Uppercase SHA-256 hex digest of the DER-encoded certificate (LocalSend v2.x format) */
  fingerprint: string;
}

function encodeDerLength(len: number): Buffer {
  if (len < 0x80) {
    return Buffer.from([len]);
  }
  const bytes: number[] = [];
  let remaining = len;
  while (remaining > 0) {
    bytes.unshift(remaining & 0xff);
    remaining >>>= 8;
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function encodeDerTlv(tag: number, content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), encodeDerLength(content.length), content]);
}

function encodeDerSequence(items: Buffer[]): Buffer {
  return encodeDerTlv(0x30, Buffer.concat(items));
}

function encodeDerSet(items: Buffer[]): Buffer {
  return encodeDerTlv(0x31, Buffer.concat(items));
}

function encodeDerPositiveInteger(raw: Buffer): Buffer {
  let start = 0;
  while (start < raw.length - 1 && raw[start] === 0 && (raw[start + 1] & 0x80) === 0) {
    start++;
  }
  const trimmed = raw.subarray(start);
  const content = (trimmed[0] & 0x80) !== 0 ? Buffer.concat([Buffer.from([0x00]), trimmed]) : trimmed;
  return encodeDerTlv(0x02, content);
}

function encodeCommonNameDistinguishedName(cn: string): Buffer {
  // OID 2.5.4.3 (id-at-commonName) = 55 04 03
  const oidCn = encodeDerTlv(0x06, Buffer.from([0x55, 0x04, 0x03]));
  const utf8Val = encodeDerTlv(0x0c, Buffer.from(cn, 'utf-8'));
  const attrTypeAndValue = encodeDerSequence([oidCn, utf8Val]);
  return encodeDerSequence([encodeDerSet([attrTypeAndValue])]);
}

function wrapPem(label: string, der: Buffer): string {
  const b64 = der.toString('base64');
  const lines: string[] = [];
  for (let i = 0; i < b64.length; i += 64) {
    lines.push(b64.slice(i, i + 64));
  }
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`;
}

/**
 * Generates a pure-Node RSA-2048 PKCS#8 private key and self-signed X.509 v3 certificate
 * matching LocalSend's Rust `cert.rs` (`CN=LocalSend User`, SHA-256 DER fingerprint).
 * Zero external binaries required (works natively on Windows & macOS).
 */
export function generateLocalSendTlsIdentity(): LocalSendTlsIdentity {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicExponent: 0x10001
  });

  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const spkiDer = publicKey.export({ type: 'spki', format: 'der' });

  // [0] EXPLICIT Version v3 (integer 2)
  const versionExplicit = encodeDerTlv(0xa0, encodeDerTlv(0x02, Buffer.from([0x02])));

  // 16-byte positive random serial number
  const serialBytes = crypto.randomBytes(16);
  serialBytes[0] = (serialBytes[0] & 0x7f) | 0x01;
  const serialNumber = encodeDerPositiveInteger(serialBytes);

  // sha256WithRSAEncryption (1.2.840.113549.1.1.11) + NULL parameters
  const sha256RsaAlgId = Buffer.from([
    0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0b, 0x05, 0x00
  ]);

  const subjectAndIssuer = encodeCommonNameDistinguishedName('LocalSend User');

  // Validity: 2024-01-01 00:00:00Z .. 2049-12-31 23:59:59Z (RFC 5280 UTCTime)
  const notBefore = encodeDerTlv(0x17, Buffer.from('240101000000Z', 'ascii'));
  const notAfter = encodeDerTlv(0x17, Buffer.from('491231235959Z', 'ascii'));
  const validity = encodeDerSequence([notBefore, notAfter]);

  const tbsCertificate = encodeDerSequence([
    versionExplicit,
    serialNumber,
    sha256RsaAlgId,
    subjectAndIssuer,
    validity,
    subjectAndIssuer,
    spkiDer
  ]);

  const signature = crypto.sign('sha256', tbsCertificate, privateKey);
  const signatureBitString = encodeDerTlv(
    0x03,
    Buffer.concat([Buffer.from([0x00]), signature])
  );

  const certDer = encodeDerSequence([tbsCertificate, sha256RsaAlgId, signatureBitString]);
  const certificatePem = wrapPem('CERTIFICATE', certDer);
  const fingerprint = crypto.createHash('sha256').update(certDer).digest('hex').toUpperCase();

  return {
    privateKeyPem,
    certificatePem,
    fingerprint
  };
}

/**
 * Validates whether persisted PEM key + cert are intact and match their DER SHA-256 fingerprint.
 */
export function isValidLocalSendTlsIdentity(
  privateKeyPem: string | undefined,
  certificatePem: string | undefined,
  fingerprint: string | undefined
): boolean {
  if (!privateKeyPem || !certificatePem || !fingerprint) return false;
  try {
    const x509 = new crypto.X509Certificate(certificatePem);
    const privKey = crypto.createPrivateKey(privateKeyPem);
    if (!x509.verify(x509.publicKey)) return false;
    if (!x509.checkPrivateKey(privKey)) return false;
    const computedFp = crypto.createHash('sha256').update(x509.raw).digest('hex').toUpperCase();
    return computedFp === fingerprint.toUpperCase();
  } catch {
    return false;
  }
}
