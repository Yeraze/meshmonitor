import { describe, it, expect, beforeEach, vi } from 'vitest';
import express, { Express } from 'express';
import session from 'express-session';
import request from 'supertest';
import mfaRoutes from './mfaRoutes.js';
import databaseService from '../../services/database.js';

vi.mock('../../services/database.js', () => ({
  default: {
    auditLog: vi.fn(),
    drizzleDbType: 'sqlite',
    findUserByIdAsync: vi.fn(),
    findUserByUsernameAsync: vi.fn(),
    checkPermissionAsync: vi.fn(),
    getUserPermissionSetAsync: vi.fn(),
    updateUserMfaSecretAsync: vi.fn(),
    enableUserMfaAsync: vi.fn(),
    clearUserMfaAsync: vi.fn(),
    consumeBackupCodeAsync: vi.fn()
  }
}));

vi.mock('../services/mfa.js', () => ({
  mfaService: {
    generateSecret: vi.fn(),
    generateQrCode: vi.fn(),
    verifyToken: vi.fn(),
    generateBackupCodes: vi.fn(),
    hashBackupCodes: vi.fn(),
    verifyBackupCode: vi.fn()
  }
}));

import { mfaService } from '../services/mfa.js';
const mockMfaService = mfaService as unknown as { [K in keyof typeof mfaService]: ReturnType<typeof vi.fn> };

const mockDatabase = databaseService as unknown as {
  auditLog: ReturnType<typeof vi.fn>;
  findUserByIdAsync: ReturnType<typeof vi.fn>;
  findUserByUsernameAsync: ReturnType<typeof vi.fn>;
  checkPermissionAsync: ReturnType<typeof vi.fn>;
  getUserPermissionSetAsync: ReturnType<typeof vi.fn>;
  updateUserMfaSecretAsync: ReturnType<typeof vi.fn>;
  enableUserMfaAsync: ReturnType<typeof vi.fn>;
  clearUserMfaAsync: ReturnType<typeof vi.fn>;
  consumeBackupCodeAsync: ReturnType<typeof vi.fn>;
};

const defaultUser = {
  id: 42,
  username: 'mfa-tester',
  isActive: true,
  isAdmin: false,
  mfaEnabled: false,
  mfaSecret: null,
  mfaBackupCodes: null,
  authProvider: 'local'
};

const createApp = (options: { authenticated?: boolean; user?: any } = {}): Express => {
  const { authenticated = true, user = defaultUser } = options;
  const app = express();
  app.use(express.json());
  app.use(
    session({
      secret: 'test-secret',
      resave: false,
      saveUninitialized: false,
      cookie: { secure: false }
    })
  );
  if (authenticated) {
    app.use((req, _res, next) => {
      req.session.userId = user.id;
      req.session.username = user.username;
      next();
    });
  }
  app.use('/api/mfa', mfaRoutes);
  return app;
};

describe('MFA Routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDatabase.findUserByIdAsync.mockResolvedValue(defaultUser);
    mockDatabase.findUserByUsernameAsync.mockResolvedValue(null);
    mockDatabase.checkPermissionAsync.mockResolvedValue(true);
    mockDatabase.getUserPermissionSetAsync.mockResolvedValue({ resources: {}, isAdmin: false });
  });

  describe('GET /api/mfa/status', () => {
    it('requires authentication', async () => {
      const app = createApp({ authenticated: false });

      const response = await request(app).get('/api/mfa/status');

      expect(response.status).toBe(401);
      expect(response.body).toHaveProperty('code', 'UNAUTHORIZED');
    });

    it('returns enabled: false when MFA is not enabled', async () => {
      const app = createApp();

      const response = await request(app).get('/api/mfa/status');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ enabled: false });
    });

    it('returns enabled: true when MFA is enabled', async () => {
      const mfaEnabledUser = { ...defaultUser, mfaEnabled: true };
      mockDatabase.findUserByIdAsync.mockResolvedValue(mfaEnabledUser);
      const app = createApp({ user: mfaEnabledUser });

      const response = await request(app).get('/api/mfa/status');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ enabled: true });
    });
  });

  describe('POST /api/mfa/setup', () => {
    it('requires authentication', async () => {
      const app = createApp({ authenticated: false });

      const response = await request(app).post('/api/mfa/setup');

      expect(response.status).toBe(401);
      expect(response.body).toHaveProperty('code', 'UNAUTHORIZED');
    });

    it('rejects non-local auth users', async () => {
      const oidcUser = { ...defaultUser, authProvider: 'oidc' };
      mockDatabase.findUserByIdAsync.mockResolvedValue(oidcUser);
      const app = createApp({ user: oidcUser });

      const response = await request(app).post('/api/mfa/setup');

      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: 'MFA is only available for local authentication accounts' });
    });

    it('rejects if MFA is already enabled', async () => {
      const mfaEnabledUser = { ...defaultUser, mfaEnabled: true };
      mockDatabase.findUserByIdAsync.mockResolvedValue(mfaEnabledUser);
      const app = createApp({ user: mfaEnabledUser });

      const response = await request(app).post('/api/mfa/setup');

      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: 'MFA is already enabled. Disable it first to reconfigure.' });
    });

    it('returns QR code, secret, and backup codes on success', async () => {
      const secret = 'JBSWY3DPEHPK3PXP';
      const otpauthUrl = 'otpauth://totp/MeshMonitor:mfa-tester?secret=JBSWY3DPEHPK3PXP&issuer=MeshMonitor';
      const qrCodeDataUrl = 'data:image/png;base64,abc123';
      const backupCodes = ['CODE0001', 'CODE0002', 'CODE0003'];
      const hashedBackupCodes = ['$2b$hash1', '$2b$hash2', '$2b$hash3'];

      mockMfaService.generateSecret.mockReturnValue({ secret, otpauthUrl });
      mockMfaService.generateQrCode.mockResolvedValue(qrCodeDataUrl);
      mockMfaService.generateBackupCodes.mockReturnValue(backupCodes);
      mockMfaService.hashBackupCodes.mockResolvedValue(hashedBackupCodes);
      mockDatabase.updateUserMfaSecretAsync.mockResolvedValue(undefined);

      const app = createApp();
      const response = await request(app).post('/api/mfa/setup');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        qrCodeDataUrl,
        secret,
        backupCodes
      });
      expect(mockMfaService.generateSecret).toHaveBeenCalledWith(defaultUser.username);
      expect(mockMfaService.generateQrCode).toHaveBeenCalledWith(otpauthUrl);
      expect(mockMfaService.generateBackupCodes).toHaveBeenCalled();
      expect(mockMfaService.hashBackupCodes).toHaveBeenCalledWith(backupCodes);
      expect(mockDatabase.updateUserMfaSecretAsync).toHaveBeenCalledWith(
        defaultUser.id,
        secret,
        JSON.stringify(hashedBackupCodes)
      );
      expect(mockDatabase.auditLog).toHaveBeenCalledWith(
        defaultUser.id,
        'mfa_setup_initiated',
        'auth',
        expect.any(String),
        expect.any(String)
      );
    });
  });

  describe('POST /api/mfa/verify-setup', () => {
    it('requires authentication', async () => {
      const app = createApp({ authenticated: false });

      const response = await request(app).post('/api/mfa/verify-setup');

      expect(response.status).toBe(401);
      expect(response.body).toHaveProperty('code', 'UNAUTHORIZED');
    });

    it('returns 400 if no token provided', async () => {
      const app = createApp();

      const response = await request(app)
        .post('/api/mfa/verify-setup')
        .send({});

      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: 'Verification code is required' });
    });

    it('returns 400 if MFA is already enabled', async () => {
      const mfaEnabledUser = { ...defaultUser, mfaEnabled: true };
      mockDatabase.findUserByIdAsync.mockResolvedValue(mfaEnabledUser);
      const app = createApp({ user: mfaEnabledUser });

      const response = await request(app)
        .post('/api/mfa/verify-setup')
        .send({ token: '123456' });

      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: 'MFA is already enabled' });
    });

    it('returns 400 if no secret is stored', async () => {
      // First call returns defaultUser (for auth middleware), which has no mfaSecret
      const app = createApp();

      const response = await request(app)
        .post('/api/mfa/verify-setup')
        .send({ token: '123456' });

      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: 'MFA setup has not been initiated. Please start setup first.' });
    });

    it('returns 400 if token is invalid', async () => {
      const userWithSecret = { ...defaultUser, mfaSecret: 'JBSWY3DPEHPK3PXP' };
      mockDatabase.findUserByIdAsync.mockResolvedValue(userWithSecret);
      mockMfaService.verifyToken.mockReturnValue(false);
      const app = createApp({ user: userWithSecret });

      const response = await request(app)
        .post('/api/mfa/verify-setup')
        .send({ token: '000000' });

      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: 'Invalid verification code. Please try again.' });
      expect(mockMfaService.verifyToken).toHaveBeenCalledWith('JBSWY3DPEHPK3PXP', '000000');
      expect(mockDatabase.auditLog).toHaveBeenCalledWith(
        defaultUser.id,
        'mfa_setup_verify_failed',
        'auth',
        expect.any(String),
        expect.any(String)
      );
    });

    it('returns success if token is valid', async () => {
      const userWithSecret = { ...defaultUser, mfaSecret: 'JBSWY3DPEHPK3PXP' };
      mockDatabase.findUserByIdAsync.mockResolvedValue(userWithSecret);
      mockMfaService.verifyToken.mockReturnValue(true);
      mockDatabase.enableUserMfaAsync.mockResolvedValue(undefined);
      const app = createApp({ user: userWithSecret });

      const response = await request(app)
        .post('/api/mfa/verify-setup')
        .send({ token: '123456' });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ success: true });
      expect(mockMfaService.verifyToken).toHaveBeenCalledWith('JBSWY3DPEHPK3PXP', '123456');
      expect(mockDatabase.enableUserMfaAsync).toHaveBeenCalledWith(defaultUser.id);
      expect(mockDatabase.auditLog).toHaveBeenCalledWith(
        defaultUser.id,
        'mfa_enabled',
        'auth',
        expect.any(String),
        expect.any(String)
      );
    });
  });

  describe('POST /api/mfa/disable', () => {
    const mfaEnabledUser = {
      ...defaultUser,
      mfaEnabled: true,
      mfaSecret: 'JBSWY3DPEHPK3PXP',
      mfaBackupCodes: JSON.stringify(['$2b$hash1', '$2b$hash2'])
    };

    it('requires authentication', async () => {
      const app = createApp({ authenticated: false });

      const response = await request(app).post('/api/mfa/disable');

      expect(response.status).toBe(401);
      expect(response.body).toHaveProperty('code', 'UNAUTHORIZED');
    });

    it('returns 400 if MFA is not enabled', async () => {
      const app = createApp();

      const response = await request(app)
        .post('/api/mfa/disable')
        .send({ token: '123456' });

      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: 'MFA is not enabled' });
    });

    it('returns 400 if no code provided', async () => {
      mockDatabase.findUserByIdAsync.mockResolvedValue(mfaEnabledUser);
      const app = createApp({ user: mfaEnabledUser });

      const response = await request(app)
        .post('/api/mfa/disable')
        .send({});

      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: 'A TOTP code or backup code is required to disable MFA' });
    });

    it('returns 401 if TOTP token is invalid', async () => {
      mockDatabase.findUserByIdAsync.mockResolvedValue(mfaEnabledUser);
      mockMfaService.verifyToken.mockReturnValue(false);
      const app = createApp({ user: mfaEnabledUser });

      const response = await request(app)
        .post('/api/mfa/disable')
        .send({ token: '000000' });

      expect(response.status).toBe(401);
      expect(response.body).toEqual({ error: 'Invalid code' });
      expect(mockMfaService.verifyToken).toHaveBeenCalledWith(mfaEnabledUser.mfaSecret, '000000');
      expect(mockDatabase.auditLog).toHaveBeenCalledWith(
        defaultUser.id,
        'mfa_disable_failed',
        'auth',
        expect.any(String),
        expect.any(String)
      );
    });

    it('returns 401 if backup code is invalid', async () => {
      mockDatabase.findUserByIdAsync.mockResolvedValue(mfaEnabledUser);
      mockMfaService.verifyBackupCode.mockResolvedValue(null);
      const app = createApp({ user: mfaEnabledUser });

      const response = await request(app)
        .post('/api/mfa/disable')
        .send({ backupCode: 'INVALID1' });

      expect(response.status).toBe(401);
      expect(response.body).toEqual({ error: 'Invalid code' });
      expect(mockMfaService.verifyBackupCode).toHaveBeenCalledWith(
        'INVALID1',
        JSON.parse(mfaEnabledUser.mfaBackupCodes)
      );
    });

    it('returns success with valid TOTP token', async () => {
      mockDatabase.findUserByIdAsync.mockResolvedValue(mfaEnabledUser);
      mockMfaService.verifyToken.mockReturnValue(true);
      mockDatabase.clearUserMfaAsync.mockResolvedValue(undefined);
      const app = createApp({ user: mfaEnabledUser });

      const response = await request(app)
        .post('/api/mfa/disable')
        .send({ token: '123456' });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ success: true });
      expect(mockMfaService.verifyToken).toHaveBeenCalledWith(mfaEnabledUser.mfaSecret, '123456');
      expect(mockDatabase.clearUserMfaAsync).toHaveBeenCalledWith(defaultUser.id);
      expect(mockDatabase.auditLog).toHaveBeenCalledWith(
        defaultUser.id,
        'mfa_disabled',
        'auth',
        expect.any(String),
        expect.any(String)
      );
    });

    it('returns success with valid backup code', async () => {
      const remainingCodes = ['$2b$hash2'];
      mockDatabase.findUserByIdAsync.mockResolvedValue(mfaEnabledUser);
      mockMfaService.verifyBackupCode.mockResolvedValue(remainingCodes);
      mockDatabase.consumeBackupCodeAsync.mockResolvedValue(undefined);
      mockDatabase.clearUserMfaAsync.mockResolvedValue(undefined);
      const app = createApp({ user: mfaEnabledUser });

      const response = await request(app)
        .post('/api/mfa/disable')
        .send({ backupCode: 'CODE0001' });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ success: true });
      expect(mockMfaService.verifyBackupCode).toHaveBeenCalledWith(
        'CODE0001',
        JSON.parse(mfaEnabledUser.mfaBackupCodes)
      );
      expect(mockDatabase.consumeBackupCodeAsync).toHaveBeenCalledWith(
        defaultUser.id,
        JSON.stringify(remainingCodes)
      );
      expect(mockDatabase.auditLog).toHaveBeenCalledWith(
        defaultUser.id,
        'mfa_backup_code_used',
        'auth',
        expect.any(String),
        expect.any(String)
      );
      expect(mockDatabase.clearUserMfaAsync).toHaveBeenCalledWith(defaultUser.id);
      expect(mockDatabase.auditLog).toHaveBeenCalledWith(
        defaultUser.id,
        'mfa_disabled',
        'auth',
        expect.any(String),
        expect.any(String)
      );
    });
  });
});
