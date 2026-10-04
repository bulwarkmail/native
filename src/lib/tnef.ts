/**
 * Minimal TNEF (Transport Neutral Encapsulation Format) parser. Port of the
 * webmail's `lib/tnef.ts` without the debug logging.
 *
 * Parses winmail.dat files sent by Microsoft Outlook to extract the HTML
 * body, plain text body, and embedded attachments.
 *
 * Reference: MS-OXTNEF / MS-TNEF specification.
 */

const TNEF_SIGNATURE = 0x223e9f78;

const LVL_MESSAGE = 0x01;
const LVL_ATTACHMENT = 0x02;

// Message-level attribute IDs
const attBody = 0x0002800c;
const attMAPIProps = 0x00069003;

// Attachment-level attribute IDs
const attAttachRenddata = 0x00069002;
const attAttachData = 0x0006800f;
const attAttachTitle = 0x00018010;
const attAttachment = 0x00069005;

// MAPI property types
const PT_SHORT = 0x0002;
const PT_LONG = 0x0003;
const PT_BOOLEAN = 0x000b;
const PT_STRING8 = 0x001e;
const PT_UNICODE = 0x001f;
const PT_BINARY = 0x0102;
const PT_SYSTIME = 0x0040;
const PT_CLSID = 0x0048;
const PT_I8 = 0x0014;

const MV_FLAG = 0x1000;

// MAPI property IDs
const PR_BODY = 0x1000;
const PR_BODY_HTML = 0x1013;
const PR_ATTACH_LONG_FILENAME = 0x3707;
const PR_ATTACH_MIME_TAG = 0x370e;
const PR_ATTACH_DATA_BIN = 0x3701;

export interface TnefAttachment {
  name: string;
  mimeType: string;
  data: Uint8Array;
}

export interface TnefResult {
  body: string | null;
  htmlBody: string | null;
  attachments: TnefAttachment[];
}

class BinaryReader {
  private view: DataView;
  private offset: number;
  private bytes: Uint8Array;

  constructor(data: Uint8Array) {
    this.bytes = data;
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    this.offset = 0;
  }

  readUint8(): number {
    const val = this.view.getUint8(this.offset);
    this.offset += 1;
    return val;
  }

  readUint16LE(): number {
    const val = this.view.getUint16(this.offset, true);
    this.offset += 2;
    return val;
  }

  readUint32LE(): number {
    const val = this.view.getUint32(this.offset, true);
    this.offset += 4;
    return val;
  }

  readBytes(length: number): Uint8Array {
    const slice = this.bytes.slice(this.offset, this.offset + length);
    this.offset += length;
    return slice;
  }

  skip(n: number): void {
    this.offset += n;
  }

  get remaining(): number {
    return this.bytes.byteLength - this.offset;
  }
}

function pad4(len: number): number {
  return (4 - (len % 4)) % 4;
}

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder('utf-8').decode(bytes);
}

function decodeUtf16le(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-16le').decode(bytes);
  } catch {
    // Hermes' TextDecoder only guarantees utf-8; decode by hand.
    let out = '';
    for (let i = 0; i + 1 < bytes.length; i += 2) {
      out += String.fromCharCode(bytes[i] | (bytes[i + 1] << 8));
    }
    return out;
  }
}

function readMAPIFixedValue(r: BinaryReader, propType: number): Uint8Array | number | null {
  switch (propType) {
    case PT_SHORT: {
      const val = r.readUint16LE();
      r.skip(2);
      return val;
    }
    case PT_LONG:
    case PT_BOOLEAN:
      return r.readUint32LE();
    case PT_I8:
    case PT_SYSTIME:
      return r.readBytes(8);
    case PT_CLSID:
      return r.readBytes(16);
    default:
      if (r.remaining >= 4) return r.readBytes(4);
      return null;
  }
}

function readMAPIVarValue(r: BinaryReader): Uint8Array | null {
  if (r.remaining < 4) return null;
  const length = r.readUint32LE();
  if (length > r.remaining) return null;
  const data = r.readBytes(length);
  r.skip(pad4(length));
  return data;
}

function isVarLengthType(baseType: number): boolean {
  return baseType === PT_STRING8 || baseType === PT_UNICODE || baseType === PT_BINARY;
}

function decodeMAPIString(data: Uint8Array, propType: number): string {
  if (propType === PT_UNICODE) {
    let len = data.byteLength;
    if (len >= 2 && data[len - 1] === 0 && data[len - 2] === 0) len -= 2;
    return decodeUtf16le(data.subarray(0, len));
  }
  let len = data.byteLength;
  if (len >= 1 && data[len - 1] === 0) len -= 1;
  return decodeUtf8(data.subarray(0, len));
}

/**
 * Read a multi-value count. Every value takes at least four bytes, so a count
 * larger than what is left of the block is a lie; clamp it rather than loop
 * up to 2^32 times on the UI thread.
 */
function readValueCount(r: BinaryReader): number {
  return Math.min(r.readUint32LE(), Math.floor(r.remaining / 4));
}

function parseMAPIProps(data: Uint8Array): Map<number, { type: number; value: Uint8Array | number | null }> {
  const props = new Map<number, { type: number; value: Uint8Array | number | null }>();
  const r = new BinaryReader(data);

  if (r.remaining < 4) return props;
  const count = r.readUint32LE();

  for (let i = 0; i < count && r.remaining >= 4; i++) {
    const propType = r.readUint16LE();
    const propID = r.readUint16LE();

    // Named properties (ID >= 0x8000) carry extra GUID + name data
    if (propID >= 0x8000) {
      if (r.remaining < 20) break;
      r.skip(16);
      const kind = r.readUint32LE();
      if (kind === 0) {
        if (r.remaining < 4) break;
        r.skip(4);
      } else {
        if (r.remaining < 4) break;
        const nameLen = r.readUint32LE();
        if (nameLen > r.remaining) break;
        r.skip(nameLen);
        r.skip(pad4(nameLen));
      }
    }

    const baseType = propType & 0x0fff;
    const isMultiValue = (propType & MV_FLAG) !== 0;

    if (isVarLengthType(baseType)) {
      if (r.remaining < 4) break;
      const valueCount = readValueCount(r);
      let lastValue: Uint8Array | null = null;
      for (let j = 0; j < valueCount && r.remaining > 0; j++) {
        const value = readMAPIVarValue(r);
        // A truncated value ends the list; retrying it would only re-read the same bytes.
        if (value === null) break;
        lastValue = value;
      }
      if (!isMultiValue && lastValue) {
        props.set(propID, { type: propType, value: lastValue });
      }
    } else if (isMultiValue) {
      if (r.remaining < 4) break;
      const valueCount = readValueCount(r);
      for (let j = 0; j < valueCount && r.remaining > 0; j++) {
        const before = r.remaining;
        readMAPIFixedValue(r, baseType);
        if (r.remaining >= before) break;
      }
    } else {
      const value = readMAPIFixedValue(r, baseType);
      props.set(propID, { type: propType, value });
    }
  }

  return props;
}

/** Parse a TNEF (winmail.dat) file and extract the body and attachments. */
export function parseTnef(data: Uint8Array): TnefResult {
  const result: TnefResult = { body: null, htmlBody: null, attachments: [] };

  if (data.byteLength < 6) return result;

  const r = new BinaryReader(data);
  const signature = r.readUint32LE();
  if (signature !== TNEF_SIGNATURE) return result;

  r.skip(2); // legacy key

  let curAttach: { name: string; mimeType: string; data: Uint8Array | null } | null = null;

  while (r.remaining >= 11) {
    const level = r.readUint8();
    const attrID = r.readUint32LE();
    const attrLen = r.readUint32LE();

    if (attrLen > r.remaining - 2) break;

    const attrData = r.readBytes(attrLen);
    r.skip(2); // checksum

    if (level === LVL_MESSAGE) {
      if (attrID === attBody) {
        result.body = decodeUtf8(attrData);
      } else if (attrID === attMAPIProps) {
        const props = parseMAPIProps(attrData);

        const htmlProp = props.get(PR_BODY_HTML);
        if (htmlProp?.value instanceof Uint8Array) {
          const baseType = htmlProp.type & 0x0fff;
          result.htmlBody = baseType === PT_STRING8 || baseType === PT_UNICODE
            ? decodeMAPIString(htmlProp.value, baseType)
            : decodeUtf8(htmlProp.value);
        }

        if (!result.body) {
          const bodyProp = props.get(PR_BODY);
          if (bodyProp?.value instanceof Uint8Array) {
            result.body = decodeMAPIString(bodyProp.value, bodyProp.type & 0x0fff);
          }
        }
      }
    } else if (level === LVL_ATTACHMENT) {
      if (attrID === attAttachRenddata) {
        if (curAttach?.data) {
          result.attachments.push({ name: curAttach.name, mimeType: curAttach.mimeType, data: curAttach.data });
        }
        curAttach = { name: 'attachment', mimeType: 'application/octet-stream', data: null };
      } else if (attrID === attAttachTitle && curAttach) {
        let len = attrData.byteLength;
        if (len > 0 && attrData[len - 1] === 0) len--;
        curAttach.name = decodeUtf8(attrData.subarray(0, len));
      } else if (attrID === attAttachData && curAttach) {
        curAttach.data = attrData;
      } else if (attrID === attAttachment && curAttach) {
        const props = parseMAPIProps(attrData);

        const longName = props.get(PR_ATTACH_LONG_FILENAME);
        if (longName?.value instanceof Uint8Array) {
          curAttach.name = decodeMAPIString(longName.value, longName.type & 0x0fff);
        }

        const mimeTag = props.get(PR_ATTACH_MIME_TAG);
        if (mimeTag?.value instanceof Uint8Array) {
          curAttach.mimeType = decodeMAPIString(mimeTag.value, mimeTag.type & 0x0fff);
        }

        const attachData = props.get(PR_ATTACH_DATA_BIN);
        if (attachData?.value instanceof Uint8Array) {
          curAttach.data = attachData.value;
        }
      }
    }
  }

  if (curAttach?.data) {
    result.attachments.push({ name: curAttach.name, mimeType: curAttach.mimeType, data: curAttach.data });
  }

  return result;
}

/** Check if a MIME attachment is a TNEF (winmail.dat) file. */
export function isTnefAttachment(name?: string | null, type?: string): boolean {
  const lowerName = (name || '').toLowerCase();
  const lowerType = (type || '').toLowerCase();
  return (
    lowerName === 'winmail.dat'
    || lowerType === 'application/ms-tnef'
    || lowerType === 'application/vnd.ms-tnef'
  );
}
