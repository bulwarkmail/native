// Stalwart's JMAP state writer, ported line by line for tests: Base32Writer
// (utils/src/codec/base32_custom.rs) fed by write_leb128 (utils/src/codec/
// leb128.rs), as `impl Display for State` (jmap-proto/src/types/state.rs)
// uses them. Kept apart from api/stalwart-state.ts on purpose, so tests check
// the decoder against an encoder written the way the server's is. Same as the
// webmail's lib/__tests__/helpers/stalwart-state.ts.

const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz792013';

class Base32Writer {
  private lastByte = 0;
  private pos = 0;
  private result = '';

  pushChar(ch: string): void {
    this.result += ch;
  }

  private pushByte(byte: number, isRemainder: boolean): void {
    let ch1: number;
    let ch2: number | null;
    switch (this.pos % 5) {
      case 0:
        ch1 = (byte & 0xf8) >> 3;
        ch2 = null;
        break;
      case 1:
        ch1 = ((this.lastByte & 0x07) << 2) | ((byte & 0xc0) >> 6);
        ch2 = (byte & 0x3e) >> 1;
        break;
      case 2:
        ch1 = ((this.lastByte & 0x01) << 4) | ((byte & 0xf0) >> 4);
        ch2 = null;
        break;
      case 3:
        ch1 = ((this.lastByte & 0x0f) << 1) | (byte >> 7);
        ch2 = (byte & 0x7c) >> 2;
        break;
      default:
        ch1 = ((this.lastByte & 0x03) << 3) | ((byte & 0xe0) >> 5);
        ch2 = byte & 0x1f;
    }
    this.result += BASE32_ALPHABET[ch1];
    if (!isRemainder) {
      if (ch2 !== null) this.result += BASE32_ALPHABET[ch2];
      this.lastByte = byte;
      this.pos += 1;
    }
  }

  writeLeb128(value: bigint): void {
    let rest = value;
    for (;;) {
      if (rest < BigInt(0x80)) {
        this.pushByte(Number(rest), false);
        return;
      }
      this.pushByte(Number((rest & BigInt(0x7f)) | BigInt(0x80)), false);
      rest >>= BigInt(7);
    }
  }

  finalize(): string {
    if (this.pos % 5 !== 0) this.pushByte(0, true);
    return this.result;
  }
}

/** `State::Exact(id).to_string()` */
export function stalwartExactState(id: bigint | number): string {
  const writer = new Base32Writer();
  writer.pushChar('s');
  writer.writeLeb128(BigInt(id));
  return writer.finalize();
}

/** `State::Intermediate { from_id, to_id, items_sent }.to_string()` */
export function stalwartIntermediateState(fromId: number, toId: number, itemsSent: number): string {
  const writer = new Base32Writer();
  writer.pushChar('r');
  writer.writeLeb128(BigInt(fromId));
  writer.writeLeb128(BigInt(toId - fromId));
  writer.writeLeb128(BigInt(itemsSent));
  return writer.finalize();
}
