import { handleEncodeMessage } from './workerProtocol.js';
import type { EncodeRequest } from './types.js';

self.onmessage = (e: MessageEvent<EncodeRequest>) => postMessage(handleEncodeMessage(e.data));
