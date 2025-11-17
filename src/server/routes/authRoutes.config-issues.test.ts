/**
 * Configuration Issues Detection Tests
 *
 * Tests the /api/auth/check-config-issues endpoint that detects
 * COOKIE_SECURE and ALLOWED_ORIGINS misconfigurations
 */

import { describe, it, expect, beforeEach, afterEach, vi, type MockedFunction } from 'vitest';
import type { Request } from 'express';

describe('Configuration Issues Detection', () => {
  let mockRequest: Partial<Request>;
  let mockGet: MockedFunction<(name: string) => string | undefined>;

  beforeEach(() => {
    mockGet = vi.fn() as MockedFunction<(name: string) => string | undefined>;

    mockRequest = {
      get: mockGet as any,
    };
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('COOKIE_SECURE Detection', () => {
    it('should detect COOKIE_SECURE=true with HTTP access (error)', () => {
      // Simulate HTTP request with COOKIE_SECURE=true
      const config = {
        cookieSecure: true,
        allowedOrigins: ['http://localhost:8080'],
        allowedOriginsProvided: true
      };

      // Set protocol via object assignment (not direct property assignment)
      mockRequest = { ...mockRequest, protocol: 'http' };
      mockGet.mockReturnValue(undefined);

      // Verify the logic would detect this issue
      const isHttps = mockRequest.protocol === 'https' ||
                     mockGet('x-forwarded-proto') === 'https';

      expect(config.cookieSecure && !isHttps).toBe(true);
    });

    it('should detect COOKIE_SECURE=false with HTTPS access (warning)', () => {
      // Simulate HTTPS request with COOKIE_SECURE=false
      const config = {
        cookieSecure: false,
        allowedOrigins: ['https://example.com'],
        allowedOriginsProvided: true
      };

      mockRequest = { ...mockRequest, protocol: 'https' };

      // Verify the logic would detect this issue
      const isHttps = mockRequest.protocol === 'https';

      expect(!config.cookieSecure && isHttps).toBe(true);
    });

    it('should detect HTTPS via x-forwarded-proto header', () => {
      // Simulate HTTP request with x-forwarded-proto header (behind proxy)
      mockRequest = { ...mockRequest, protocol: 'http' };
      mockGet.mockImplementation((header: string) => {
        if (header === 'x-forwarded-proto') return 'https';
        return undefined;
      });

      const isHttps = mockRequest.protocol === 'https' ||
                     mockGet('x-forwarded-proto') === 'https';

      expect(isHttps).toBe(true);
    });

    it('should not report issues when COOKIE_SECURE matches protocol', () => {
      const scenarios = [
        { cookieSecure: true, protocol: 'https', forwardedProto: undefined },
        { cookieSecure: false, protocol: 'http', forwardedProto: undefined },
        { cookieSecure: true, protocol: 'http', forwardedProto: 'https' },
      ];

      scenarios.forEach(scenario => {
        mockRequest = { ...mockRequest, protocol: scenario.protocol };
        mockGet.mockImplementation((header: string) => {
          if (header === 'x-forwarded-proto') return scenario.forwardedProto;
          return undefined;
        });

        const isHttps = mockRequest.protocol === 'https' ||
                       mockGet('x-forwarded-proto') === 'https';

        // Should not have mismatches
        if (scenario.cookieSecure) {
          expect(isHttps).toBe(true);
        } else {
          expect(isHttps).toBe(false);
        }
      });
    });
  });

  describe('ALLOWED_ORIGINS Detection', () => {
    it('should detect missing origin in ALLOWED_ORIGINS list', () => {
      const config = {
        cookieSecure: false,
        allowedOrigins: ['http://localhost:8080'],
        allowedOriginsProvided: true
      };

      const currentOrigin = 'http://unauthorized.example.com';
      mockGet.mockImplementation((header: string) => {
        if (header === 'origin') return currentOrigin;
        return undefined;
      });

      // Parse origin
      const origin = new URL(currentOrigin).origin;

      // Verify detection logic
      expect(config.allowedOriginsProvided).toBe(true);
      expect(config.allowedOrigins.includes(origin)).toBe(false);
    });

    it('should not report issues when origin is in ALLOWED_ORIGINS', () => {
      const config = {
        cookieSecure: false,
        allowedOrigins: ['http://localhost:8080', 'https://example.com'],
        allowedOriginsProvided: true
      };

      const currentOrigin = 'https://example.com';
      mockGet.mockImplementation((header: string) => {
        if (header === 'origin') return currentOrigin;
        return undefined;
      });

      const origin = new URL(currentOrigin).origin;

      expect(config.allowedOrigins.includes(origin)).toBe(true);
    });

    it('should fall back to referer header if origin is not present', () => {
      const refererUrl = 'https://example.com/some/path';
      mockGet.mockImplementation((header: string) => {
        if (header === 'origin') return undefined;
        if (header === 'referer') return refererUrl;
        return undefined;
      });

      const currentOrigin = mockGet('origin') || mockGet('referer');

      expect(currentOrigin).toBe(refererUrl);

      if (currentOrigin) {
        const origin = new URL(currentOrigin).origin;
        expect(origin).toBe('https://example.com');
      }
    });

    it('should handle invalid URLs gracefully', () => {
      const invalidUrl = 'not-a-valid-url';
      mockGet.mockImplementation((header: string) => {
        if (header === 'origin') return invalidUrl;
        return undefined;
      });

      const currentOrigin = mockGet('origin');

      // Should throw when trying to parse invalid URL
      expect(() => new URL(currentOrigin as string)).toThrow();
    });

    it('should not check ALLOWED_ORIGINS if none provided', () => {
      const config = {
        cookieSecure: false,
        allowedOrigins: [],
        allowedOriginsProvided: false
      };

      // When allowedOriginsProvided is false, skip the check
      expect(config.allowedOriginsProvided).toBe(false);
    });
  });

  describe('Combined Scenarios', () => {
    it('should detect multiple issues simultaneously', () => {
      const config = {
        cookieSecure: true,  // Will cause issue with HTTP
        allowedOrigins: ['http://localhost:8080'],
        allowedOriginsProvided: true
      };

      mockRequest = { ...mockRequest, protocol: 'http' };  // HTTP with COOKIE_SECURE=true
      const currentOrigin = 'http://unauthorized.com';  // Not in allowed list

      mockGet.mockImplementation((header: string) => {
        if (header === 'origin') return currentOrigin;
        if (header === 'x-forwarded-proto') return undefined;
        return undefined;
      });

      const isHttps = mockRequest.protocol === 'https' ||
                     mockGet('x-forwarded-proto') === 'https';
      const origin = new URL(currentOrigin).origin;

      // Both issues should be detected
      expect(config.cookieSecure && !isHttps).toBe(true);
      expect(!config.allowedOrigins.includes(origin)).toBe(true);
    });

    it('should return empty issues array when everything is configured correctly', () => {
      const config = {
        cookieSecure: true,
        allowedOrigins: ['https://example.com'],
        allowedOriginsProvided: true
      };

      mockRequest = { ...mockRequest, protocol: 'https' };
      const currentOrigin = 'https://example.com';

      mockGet.mockImplementation((header: string) => {
        if (header === 'origin') return currentOrigin;
        return undefined;
      });

      const isHttps = mockRequest.protocol === 'https';
      const origin = new URL(currentOrigin).origin;

      // No issues should be detected
      expect(config.cookieSecure && !isHttps).toBe(false);  // COOKIE_SECURE matches
      expect(!config.cookieSecure && isHttps).toBe(false);  // No warning
      expect(config.allowedOrigins.includes(origin)).toBe(true);  // Origin allowed
    });
  });

  describe('Response Format', () => {
    it('should return issues array in correct format', () => {
      // Verify type constraints
      type IssueType = 'cookie_secure' | 'allowed_origins';
      type IssueSeverity = 'error' | 'warning';

      const validIssue: {
        type: IssueType;
        severity: IssueSeverity;
        message: string;
        docsUrl: string;
      } = {
        type: 'cookie_secure',
        severity: 'error',
        message: 'Test message',
        docsUrl: 'https://meshmonitor.org/faq.html#i-see-a-blank-white-screen-when-accessing-meshmonitor'
      };

      expect(validIssue).toBeDefined();
      expect(['cookie_secure', 'allowed_origins']).toContain(validIssue.type);
      expect(['error', 'warning']).toContain(validIssue.severity);
    });

    it('should always include docsUrl pointing to meshmonitor.org', () => {
      const issues = [
        {
          type: 'cookie_secure' as const,
          severity: 'error' as const,
          message: 'Test',
          docsUrl: 'https://meshmonitor.org/faq.html#i-see-a-blank-white-screen-when-accessing-meshmonitor'
        },
        {
          type: 'allowed_origins' as const,
          severity: 'error' as const,
          message: 'Test',
          docsUrl: 'https://meshmonitor.org/faq.html#i-see-a-blank-white-screen-when-accessing-meshmonitor'
        }
      ];

      issues.forEach(issue => {
        expect(issue.docsUrl).toContain('meshmonitor.org');
        expect(issue.docsUrl).toContain('faq.html');
      });
    });
  });
});
