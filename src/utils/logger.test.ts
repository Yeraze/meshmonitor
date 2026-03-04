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

  it('should show all log levels when LOG_LEVEL=debug', async () => {
    process.env.LOG_LEVEL = 'debug';
    const logger = await importLogger();

    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('e');

    expect(consoleMocks.log).toHaveBeenCalledWith('[DEBUG]', 'd');
    expect(consoleMocks.log).toHaveBeenCalledWith('[INFO]', 'i');
    expect(consoleMocks.warn).toHaveBeenCalledWith('[WARN]', 'w');
    expect(consoleMocks.error).toHaveBeenCalledWith('[ERROR]', 'e');
  });

  it('should suppress debug when LOG_LEVEL=info', async () => {
    process.env.LOG_LEVEL = 'info';
    const logger = await importLogger();

    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('e');

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
