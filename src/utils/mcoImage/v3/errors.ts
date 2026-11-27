// Upstream: MCOImageV3CodecError / MCOImageV3InvalidPayloadError (lines 83-85).
// MIT, (c) 2025 zjs81; see decoder.ts for the full licence text.

export class McoImageV3CodecError extends Error {
  constructor(message?: string) {
    super(message);
    this.name = 'McoImageV3CodecError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class McoImageV3InvalidPayloadError extends McoImageV3CodecError {
  constructor(message?: string) {
    super(message);
    this.name = 'McoImageV3InvalidPayloadError';
  }
}

// Upstream: MCOImageV3InvalidInputError (line 84). Thrown by the encoder for bad input.
export class McoImageV3InvalidInputError extends McoImageV3CodecError {
  constructor(message?: string) {
    super(message);
    this.name = 'McoImageV3InvalidInputError';
  }
}
