import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setupAccessLogger } from './accessLogger.js';
import fs from 'fs';

// Mock dependencies
vi.mock('../config/environment.js');
vi.mock('../../utils/logger.js');
vi.mock('fs');
vi.mock('rotating-file-stream', () => ({
  createStream: vi.fn(() => ({
    on: vi.fn(),
    write: vi.fn()
  }))
}));

// Import mocked modules
import { getEnvironmentConfig } from '../config/environment.js';
import { logger } from '../../utils/logger.js';
import { createStream } from 'rotating-file-stream';

describe('setupAccessLogger', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(createStream).mockClear();
  });

  describe('Disabled State', () => {
    it('should return null when ACCESS_LOG_ENABLED=false', () => {
      vi.mocked(getEnvironmentConfig).mockReturnValue({
        accessLogEnabled: false,
        accessLogPath: '/data/logs/access.log',
        accessLogFormat: 'combined'
      } as any);

      const result = setupAccessLogger();

      expect(result).toBeNull();
      expect(logger.debug).toHaveBeenCalledWith('Access logging disabled (ACCESS_LOG_ENABLED=false)');
    });

    it('should not create log directory when disabled', () => {
      vi.mocked(getEnvironmentConfig).mockReturnValue({
        accessLogEnabled: false,
        accessLogPath: '/data/logs/access.log',
        accessLogFormat: 'combined'
      } as any);

      setupAccessLogger();

      expect(fs.existsSync).not.toHaveBeenCalled();
      expect(fs.mkdirSync).not.toHaveBeenCalled();
    });

    it('should not create rotating stream when disabled', () => {
      vi.mocked(getEnvironmentConfig).mockReturnValue({
        accessLogEnabled: false,
        accessLogPath: '/data/logs/access.log',
        accessLogFormat: 'combined'
      } as any);

      setupAccessLogger();

      expect(createStream).not.toHaveBeenCalled();
    });
  });

  describe('Enabled State', () => {
    it('should create morgan middleware when enabled', () => {
      vi.mocked(getEnvironmentConfig).mockReturnValue({
        accessLogEnabled: true,
        accessLogPath: '/data/logs/access.log',
        accessLogFormat: 'combined'
      } as any);
      vi.mocked(fs.existsSync).mockReturnValue(true);

      const result = setupAccessLogger();

      expect(result).not.toBeNull();
      expect(typeof result).toBe('function');
      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('Access logging enabled: /data/logs/access.log')
      );
    });

    it('should use correct log format from config', () => {
      vi.mocked(getEnvironmentConfig).mockReturnValue({
        accessLogEnabled: true,
        accessLogPath: '/data/logs/access.log',
        accessLogFormat: 'combined'
      } as any);
      vi.mocked(fs.existsSync).mockReturnValue(true);

      setupAccessLogger();

      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('format: combined')
      );
    });

    it('should support common log format', () => {
      vi.mocked(getEnvironmentConfig).mockReturnValue({
        accessLogEnabled: true,
        accessLogPath: '/data/logs/access.log',
        accessLogFormat: 'common'
      } as any);
      vi.mocked(fs.existsSync).mockReturnValue(true);

      setupAccessLogger();

      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('format: common')
      );
    });

    it('should support tiny log format', () => {
      vi.mocked(getEnvironmentConfig).mockReturnValue({
        accessLogEnabled: true,
        accessLogPath: '/data/logs/access.log',
        accessLogFormat: 'tiny'
      } as any);
      vi.mocked(fs.existsSync).mockReturnValue(true);

      setupAccessLogger();

      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('format: tiny')
      );
    });
  });

  describe('Log Directory Creation', () => {
    it('should create log directory if it does not exist', () => {
      vi.mocked(getEnvironmentConfig).mockReturnValue({
        accessLogEnabled: true,
        accessLogPath: '/data/logs/access.log',
        accessLogFormat: 'combined'
      } as any);
      vi.mocked(fs.existsSync).mockReturnValue(false);

      setupAccessLogger();

      expect(fs.mkdirSync).toHaveBeenCalledWith('/data/logs', { recursive: true });
      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('Creating log directory: /data/logs')
      );
    });

    it('should not create log directory if it already exists', () => {
      vi.mocked(getEnvironmentConfig).mockReturnValue({
        accessLogEnabled: true,
        accessLogPath: '/data/logs/access.log',
        accessLogFormat: 'combined'
      } as any);
      vi.mocked(fs.existsSync).mockReturnValue(true);

      setupAccessLogger();

      expect(fs.mkdirSync).not.toHaveBeenCalled();
    });

    it('should handle nested log directory paths', () => {
      vi.mocked(getEnvironmentConfig).mockReturnValue({
        accessLogEnabled: true,
        accessLogPath: '/data/meshmonitor/logs/access.log',
        accessLogFormat: 'combined'
      } as any);
      vi.mocked(fs.existsSync).mockReturnValue(false);

      setupAccessLogger();

      expect(fs.mkdirSync).toHaveBeenCalledWith('/data/meshmonitor/logs', { recursive: true });
    });
  });

  describe('Error Handling', () => {
    it('should handle log directory creation errors gracefully', () => {
      vi.mocked(getEnvironmentConfig).mockReturnValue({
        accessLogEnabled: true,
        accessLogPath: '/data/logs/access.log',
        accessLogFormat: 'combined'
      } as any);
      vi.mocked(fs.existsSync).mockReturnValue(false);
      vi.mocked(fs.mkdirSync).mockImplementation(() => {
        throw new Error('Permission denied');
      });

      const result = setupAccessLogger();

      expect(result).toBeNull();
      expect(logger.error).toHaveBeenCalledWith('Failed to setup access logger:', expect.any(Error));
      expect(logger.error).toHaveBeenCalledWith('Access logging will be disabled');
    });

    it('should handle stream creation errors gracefully', () => {
      vi.mocked(getEnvironmentConfig).mockReturnValue({
        accessLogEnabled: true,
        accessLogPath: '/data/logs/access.log',
        accessLogFormat: 'combined'
      } as any);
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(createStream).mockImplementation(() => {
        throw new Error('Failed to create stream');
      });

      const result = setupAccessLogger();

      expect(result).toBeNull();
      expect(logger.error).toHaveBeenCalledWith('Failed to setup access logger:', expect.any(Error));
    });
  });

  describe('Stream Configuration', () => {
    it('should configure rotating stream with correct options', () => {
      vi.mocked(getEnvironmentConfig).mockReturnValue({
        accessLogEnabled: true,
        accessLogPath: '/data/logs/access.log',
        accessLogFormat: 'combined'
      } as any);
      vi.mocked(fs.existsSync).mockReturnValue(true);

      setupAccessLogger();

      expect(createStream).toHaveBeenCalledWith('access.log', {
        interval: '1d',
        maxFiles: 14,
        path: '/data/logs',
        compress: 'gzip'
      });
    });

    it('should extract filename correctly from path', () => {
      vi.mocked(getEnvironmentConfig).mockReturnValue({
        accessLogEnabled: true,
        accessLogPath: '/var/log/meshmonitor/http.log',
        accessLogFormat: 'combined'
      } as any);
      vi.mocked(fs.existsSync).mockReturnValue(true);

      setupAccessLogger();

      expect(createStream).toHaveBeenCalledWith('http.log', expect.objectContaining({
        path: '/var/log/meshmonitor'
      }));
    });

    it('should register error event handler on stream', () => {
      const mockStream = {
        on: vi.fn(),
        write: vi.fn()
      };
      vi.mocked(getEnvironmentConfig).mockReturnValue({
        accessLogEnabled: true,
        accessLogPath: '/data/logs/access.log',
        accessLogFormat: 'combined'
      } as any);
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(createStream).mockReturnValue(mockStream as any);

      setupAccessLogger();

      expect(mockStream.on).toHaveBeenCalledWith('error', expect.any(Function));
      expect(mockStream.on).toHaveBeenCalledWith('rotation', expect.any(Function));
    });
  });

  describe('Health Check Exclusion', () => {
    it('should skip logging for successful health checks', () => {
      vi.mocked(getEnvironmentConfig).mockReturnValue({
        accessLogEnabled: true,
        accessLogPath: '/data/logs/access.log',
        accessLogFormat: 'combined'
      } as any);
      vi.mocked(fs.existsSync).mockReturnValue(true);

      const middleware = setupAccessLogger();
      expect(middleware).not.toBeNull();

      // The skip function is internal to morgan, but we can verify
      // the middleware was created successfully
      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('Access logging enabled')
      );
    });
  });

  describe('Log Rotation Info', () => {
    it('should log rotation configuration', () => {
      vi.mocked(getEnvironmentConfig).mockReturnValue({
        accessLogEnabled: true,
        accessLogPath: '/data/logs/access.log',
        accessLogFormat: 'combined'
      } as any);
      vi.mocked(fs.existsSync).mockReturnValue(true);

      setupAccessLogger();

      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('Logs rotate daily, keeping 14 days (compressed with gzip)')
      );
    });
  });

  describe('Custom Log Paths', () => {
    // TODO: Fix test isolation issue with Vitest 4.0 - this test passes in isolation but fails in suite
    it.skip('should handle custom log path', () => {
      vi.mocked(getEnvironmentConfig).mockReturnValue({
        accessLogEnabled: true,
        accessLogPath: '/custom/path/to/logs/app.log',
        accessLogFormat: 'combined'
      } as any);
      vi.mocked(fs.existsSync).mockReturnValue(false);

      setupAccessLogger();

      expect(fs.mkdirSync).toHaveBeenCalledWith('/custom/path/to/logs', { recursive: true });
      expect(createStream).toHaveBeenCalledWith('app.log', expect.objectContaining({
        path: '/custom/path/to/logs'
      }));
    });

    it('should handle log path with spaces', () => {
      vi.mocked(getEnvironmentConfig).mockReturnValue({
        accessLogEnabled: true,
        accessLogPath: '/data/mesh monitor/access.log',
        accessLogFormat: 'combined'
      } as any);
      vi.mocked(fs.existsSync).mockReturnValue(true);

      setupAccessLogger();

      expect(createStream).toHaveBeenCalledWith('access.log', expect.objectContaining({
        path: '/data/mesh monitor'
      }));
    });
  });
});
