/**
 * One-off helper: take a Meshtastic channel-config URL, clear channel 0's
 * `name` field, and emit a new URL with the primary channel unnamed.
 *
 * Used by tests/test-config-import.sh authors to keep URL_1 (the first
 * import cycle in the system test suite) representative of a real
 * default device — Meshtastic's factory state leaves the primary channel
 * with an empty `name`.
 *
 * Run with: npx tsx scripts/rebuild-config-url.ts <URL>
 */
import { loadProtobufDefinitions, getProtobufRoot } from '../src/server/protobufLoader.js';

function urlsafeB64Decode(b64: string): Buffer {
  const padLen = (4 - (b64.length % 4)) % 4;
  const padded = b64 + '='.repeat(padLen);
  const normal = padded.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(normal, 'base64');
}

async function main() {
  const url = process.argv[2];
  if (!url) {
    console.error('Usage: npx tsx scripts/rebuild-config-url.ts <meshtastic-channel-url>');
    process.exit(1);
  }

  await loadProtobufDefinitions();
  const root = getProtobufRoot();
  if (!root) throw new Error('protobuf root not loaded');

  const ChannelSet = root.lookupType('meshtastic.ChannelSet');

  const fragment = url.split('#')[1];
  const bytes = urlsafeB64Decode(fragment);
  const decoded = ChannelSet.decode(bytes);
  const obj: any = ChannelSet.toObject(decoded, { defaults: true, longs: Number, enums: Number, bytes: String });

  console.log('Before:');
  for (const [i, s] of (obj.settings ?? []).entries()) {
    console.log(`  [${i}] role=${s.role} name=${JSON.stringify(s.name)}`);
  }

  if (obj.settings && obj.settings.length > 0) {
    obj.settings[0].name = '';
  }

  // toObject with bytes:String gave us base64; encode wants Uint8Array back.
  if (obj.settings) {
    for (const s of obj.settings) {
      if (typeof s.psk === 'string') {
        s.psk = Buffer.from(s.psk, 'base64');
      }
    }
  }

  const reencoded = ChannelSet.create(obj);
  const encoded = ChannelSet.encode(reencoded).finish();
  const b64 = Buffer.from(encoded).toString('base64').replace(/=+$/, '');
  const newUrl = `https://meshtastic.org/e/#${b64}`;

  console.log('\nAfter:');
  const verify = ChannelSet.decode(urlsafeB64Decode(b64));
  const verifyObj: any = ChannelSet.toObject(verify, { defaults: true, longs: Number, enums: Number });
  for (const [i, s] of (verifyObj.settings ?? []).entries()) {
    console.log(`  [${i}] role=${s.role} name=${JSON.stringify(s.name)}`);
  }

  console.log('\nNew URL:');
  console.log(newUrl);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
