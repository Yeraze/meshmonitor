// Upstream: MCOImageCodecException family (mcoimg_types.dart lines 187-220).
// MIT, (c) 2025 zjs81; see decoder.ts for the full licence text.

export class McoImageV4CodecError extends Error {
  constructor(message?: string) {
    super(message);
    this.name = 'McoImageV4CodecError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Damaged payload. */
export class McoImageV4InvalidPayloadError extends McoImageV4CodecError {
  constructor(message?: string) {
    super(message);
    this.name = 'McoImageV4InvalidPayloadError';
  }
}

/** A feature this decoder does not know (newer mode, command or MCOtxt version). */
export class McoImageV4UnsupportedFormatError extends McoImageV4CodecError {
  constructor(message?: string) {
    super(message);
    this.name = 'McoImageV4UnsupportedFormatError';
  }
}

/** A MeshMonitor decode limit was exceeded (the upstream codec has none). */
export class McoImageV4TooLargeError extends McoImageV4CodecError {
  constructor(message?: string) {
    super(message);
    this.name = 'McoImageV4TooLargeError';
  }
}
