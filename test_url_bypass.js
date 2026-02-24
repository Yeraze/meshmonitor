/**
 * Test script to check for URL parsing bypass techniques
 * Testing if Node.js URL parser can be bypassed to access unintended hosts
 */

const testURLs = [
  // Standard valid URL
  'https://raw.githubusercontent.com/user/repo/main/script.py',

  // URL parsing bypass attempts
  'https://raw.githubusercontent.com@evil.com/path',
  'https://evil.com#@raw.githubusercontent.com/path',
  'https://raw.githubusercontent.com.evil.com/path',
  'https://raw.githubusercontent.com%2F@evil.com/path',
  'https://raw.githubusercontent.com%0a@evil.com/path',
  'https://raw.githubusercontent.com:80@evil.com/path',
  'https://user:pass@raw.githubusercontent.com@evil.com/path',

  // Unicode/IDN homograph attacks
  'https://raw.githuḃusercontent.com/path', // unicode dot
  'https://raw.githubusercontent.com/path', // might contain lookalike chars

  // Port manipulation
  'https://raw.githubusercontent.com:8080/path',
  'https://raw.githubusercontent.com:22/path',

  // CRLF injection
  'https://raw.githubusercontent.com/%0d%0aHost: evil.com',

  // Backslash confusion
  'https://raw.githubusercontent.com\\@evil.com/path',
  'https://raw.githubusercontent.com\\.evil.com/path',

  // URL fragments
  'https://raw.githubusercontent.com#evil.com',

  // Subdomain attempts
  'https://evil.raw.githubusercontent.com/path',
  'https://raw.githubusercontent.com.evil.com/path',

  // Internal IP attempts (should be allowed by current code)
  'https://127.0.0.1/path',
  'https://localhost/path',
  'https://169.254.169.254/latest/meta-data/', // AWS metadata
  'https://metadata.google.internal/computeMetadata/v1/', // GCP metadata

  // Integer IP representation
  'https://2130706433/', // 127.0.0.1 in integer
  'https://0x7f000001/', // 127.0.0.1 in hex
  'https://0177.0.0.1/', // 127.0.0.1 in octal

  // IPv6 localhost
  'https://[::1]/path',
  'https://[0:0:0:0:0:0:0:1]/path',
];

console.log('Testing URL parsing behavior:\n');

for (const testUrl of testURLs) {
  try {
    const parsed = new URL(testUrl);
    const hostname = parsed.hostname;
    const protocol = parsed.protocol;

    const isValid = hostname === 'raw.githubusercontent.com' && protocol === 'https:';

    console.log(`URL: ${testUrl}`);
    console.log(`  Hostname: ${hostname}`);
    console.log(`  Protocol: ${protocol}`);
    console.log(`  Valid: ${isValid}`);
    console.log(`  Would be blocked: ${!isValid}`);
    console.log();
  } catch (error) {
    console.log(`URL: ${testUrl}`);
    console.log(`  Error: ${error.message}`);
    console.log();
  }
}
