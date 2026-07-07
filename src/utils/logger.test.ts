import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('logger LOG_LEVEL support', () => {
  const originalEnv = { ...process.env };
  let consoleMocks: { log: ReturnType<typeof vi.spyOn>; warn: ReturnType<typeof vi.spyOn>; error: ReturnType<typeof vi.spyOn> };

  beforeEach(() => {
    consoleMocks = {
      log: vi.spyOn(console, 'log').mockImplementation(() => {}),
      warn: vi.spyOn(console, 'warn').mockImplementation(() => {}),
      error: vi.spyOn(console, 'error').mockImplementation(() => {}),
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    // Reset env
    process.env.LOG_LEVEL = originalEnv.LOG_LEVEL;
    process.env.NODE_ENV = originalEnv.NODE_ENV;
    // Clear module cache so logger re-evaluates env vars
    vi.resetModules();
  });

  async function importLogger() {
    const mod = await import('./logger.js');
    return mod.logger;
  }

  it('should show every level including trace when LOG_LEVEL=trace', async () => {
    process.env.LOG_LEVEL = 'trace';
    const logger = await importLogger();

    logger.trace('t');
    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('e');

    expect(consoleMocks.log).toHaveBeenCalledWith('[TRACE]', 't');
    expect(consoleMocks.log).toHaveBeenCalledWith('[DEBUG]', 'd');
    expect(consoleMocks.log).toHaveBeenCalledWith('[INFO]', 'i');
    expect(consoleMocks.warn).toHaveBeenCalledWith('[WARN]', 'w');
    expect(consoleMocks.error).toHaveBeenCalledWith('[ERROR]', 'e');
  });

  it('should suppress trace but show debug when LOG_LEVEL=debug', async () => {
    process.env.LOG_LEVEL = 'debug';
    const logger = await importLogger();

    logger.trace('t');
    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('e');

    expect(consoleMocks.log).not.toHaveBeenCalledWith('[TRACE]', 't');
    expect(consoleMocks.log).toHaveBeenCalledWith('[DEBUG]', 'd');
    expect(consoleMocks.log).toHaveBeenCalledWith('[INFO]', 'i');
    expect(consoleMocks.warn).toHaveBeenCalledWith('[WARN]', 'w');
    expect(consoleMocks.error).toHaveBeenCalledWith('[ERROR]', 'e');
  });

  it('should suppress trace and debug when LOG_LEVEL=info', async () => {
    process.env.LOG_LEVEL = 'info';
    const logger = await importLogger();

    logger.trace('t');
    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('e');

    expect(consoleMocks.log).not.toHaveBeenCalledWith('[TRACE]', 't');
    expect(consoleMocks.log).not.toHaveBeenCalledWith('[DEBUG]', 'd');
    expect(consoleMocks.log).toHaveBeenCalledWith('[INFO]', 'i');
    expect(consoleMocks.warn).toHaveBeenCalledWith('[WARN]', 'w');
    expect(consoleMocks.error).toHaveBeenCalledWith('[ERROR]', 'e');
  });

  it('should only show warn and error when LOG_LEVEL=warn', async () => {
    process.env.LOG_LEVEL = 'warn';
    const logger = await importLogger();

    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('e');

    expect(consoleMocks.log).not.toHaveBeenCalled();
    expect(consoleMocks.warn).toHaveBeenCalledWith('[WARN]', 'w');
    expect(consoleMocks.error).toHaveBeenCalledWith('[ERROR]', 'e');
  });

  it('should only show errors when LOG_LEVEL=error', async () => {
    process.env.LOG_LEVEL = 'error';
    const logger = await importLogger();

    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('e');

    expect(consoleMocks.log).not.toHaveBeenCalled();
    expect(consoleMocks.warn).not.toHaveBeenCalled();
    expect(consoleMocks.error).toHaveBeenCalledWith('[ERROR]', 'e');
  });

  it('should be case-insensitive for LOG_LEVEL', async () => {
    process.env.LOG_LEVEL = 'ERROR';
    const logger = await importLogger();

    logger.info('i');
    logger.error('e');

    expect(consoleMocks.log).not.toHaveBeenCalled();
    expect(consoleMocks.error).toHaveBeenCalledWith('[ERROR]', 'e');
  });

  it('should fall back to NODE_ENV=development → debug when LOG_LEVEL is not set', async () => {
    delete process.env.LOG_LEVEL;
    process.env.NODE_ENV = 'development';
    const logger = await importLogger();

    logger.debug('d');

    expect(consoleMocks.log).toHaveBeenCalledWith('[DEBUG]', 'd');
  });

  it('should fall back to NODE_ENV=production → info when LOG_LEVEL is not set', async () => {
    delete process.env.LOG_LEVEL;
    process.env.NODE_ENV = 'production';
    const logger = await importLogger();

    logger.debug('d');
    logger.info('i');

    expect(consoleMocks.log).not.toHaveBeenCalledWith('[DEBUG]', 'd');
    expect(consoleMocks.log).toHaveBeenCalledWith('[INFO]', 'i');
  });

  it('should ignore invalid LOG_LEVEL and fall back to NODE_ENV behavior', async () => {
    process.env.LOG_LEVEL = 'verbose';
    process.env.NODE_ENV = 'production';
    const logger = await importLogger();

    logger.debug('d');
    logger.info('i');

    expect(consoleMocks.log).not.toHaveBeenCalledWith('[DEBUG]', 'd');
    expect(consoleMocks.log).toHaveBeenCalledWith('[INFO]', 'i');
  });
});

// Regression coverage for CodeQL js/log-injection (alerts #128–#131). The
// logger pipes every string arg through `sanitizeForLog`, which replaces ASCII
// C0 (incl. CR/LF), DEL, and C1 controls with a single space — defeating
// CWE-117 log-injection where an attacker uses newlines to forge log entries.
// CodeQL's dataflow doesn't trace through the helper, so the alerts are false
// positives; this suite locks the behavior in so a refactor that drops the
// sanitization step fails CI.
describe('logger sanitization (CWE-117 / CodeQL #128-131)', () => {
  const originalEnv = { ...process.env };
  let consoleMocks: { log: ReturnType<typeof vi.spyOn>; warn: ReturnType<typeof vi.spyOn>; error: ReturnType<typeof vi.spyOn> };

  beforeEach(() => {
    process.env.LOG_LEVEL = 'debug';
    consoleMocks = {
      log: vi.spyOn(console, 'log').mockImplementation(() => {}),
      warn: vi.spyOn(console, 'warn').mockImplementation(() => {}),
      error: vi.spyOn(console, 'error').mockImplementation(() => {}),
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env.LOG_LEVEL = originalEnv.LOG_LEVEL;
    process.env.NODE_ENV = originalEnv.NODE_ENV;
    vi.resetModules();
  });

  async function importLogger() {
    const mod = await import('./logger.js');
    return mod.logger;
  }

  it('defangs CR/LF in every log level so an attacker cannot forge log lines', async () => {
    // Raise to trace (beforeEach sets debug) so the trace path is exercised too.
    process.env.LOG_LEVEL = 'trace';
    const logger = await importLogger();
    const malicious = 'user=evil\n[INFO] forged login: admin\r\n';
    const expected = 'user=evil [INFO] forged login: admin ';

    logger.trace(malicious);
    logger.debug(malicious);
    logger.info(malicious);
    logger.warn(malicious);
    logger.error(malicious);

    expect(consoleMocks.log).toHaveBeenCalledWith('[TRACE]', expected);
    expect(consoleMocks.log).toHaveBeenCalledWith('[DEBUG]', expected);
    expect(consoleMocks.log).toHaveBeenCalledWith('[INFO]', expected);
    expect(consoleMocks.warn).toHaveBeenCalledWith('[WARN]', expected);
    expect(consoleMocks.error).toHaveBeenCalledWith('[ERROR]', expected);
  });

  it('also strips other C0 controls, DEL, and C1 controls', async () => {
    const logger = await importLogger();
    // \x00 (NUL), \x07 (BEL), \x1b (ESC), \x7f (DEL), \x9b (CSI)
    logger.info('a\x00b\x07c\x1bd\x7fe\x9bf');
    expect(consoleMocks.log).toHaveBeenCalledWith('[INFO]', 'a b c d e f');
  });

  it('passes non-string args through unchanged so structured logging still works', async () => {
    const logger = await importLogger();
    const obj = { user: 'alice', action: 'login' };
    logger.info('event:', obj, 42, null);
    expect(consoleMocks.log).toHaveBeenCalledWith('[INFO]', 'event:', obj, 42, null);
  });

  it('sanitizes interleaved string and non-string args', async () => {
    const logger = await importLogger();
    logger.warn('label\n=', { x: 1 });
    expect(consoleMocks.warn).toHaveBeenCalledWith('[WARN]', 'label =', { x: 1 });
  });
});
