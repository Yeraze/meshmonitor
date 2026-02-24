/**
 * Config Routes Integration Tests
 *
 * Tests /api/config endpoint including localNodeInfo for anonymous users
 */

import { describe, it, expect, beforeEach, beforeAll, vi } from 'vitest';
import express, { Express } from 'express';
import session from 'express-session';
import request from 'supertest';
import DatabaseService from '../../services/database.js';
import { getEnvironmentConfig } from '../config/environment.js';

describe('/api/config endpoint', () => {
  let app: Express;
  let mockGetSetting: any;
  let mockGetNode: any;

  beforeAll(() => {
    // Setup express app for testing
    app = express();
    app.use(express.json());
    app.use(
      session({
        secret: 'test-secret',
        resave: false,
        saveUninitialized: false,
        cookie: { secure: false }
      })
    );

    // Create a simple route that mimics the /api/config endpoint
    app.get('/api/config', async (_req, res) => {
      try {
        const localNodeNumStr = DatabaseService.getSetting('localNodeNum');

        let deviceMetadata = undefined;
        let localNodeInfo = undefined;
        if (localNodeNumStr) {
          const localNodeNum = parseInt(localNodeNumStr, 10);
          const currentNode = DatabaseService.getNode(localNodeNum);

          if (currentNode) {
            deviceMetadata = {
              firmwareVersion: currentNode.firmwareVersion,
              rebootCount: currentNode.rebootCount
            };

            // Include local node identity information for anonymous users
            localNodeInfo = {
              nodeId: currentNode.nodeId,
              longName: currentNode.longName,
              shortName: currentNode.shortName
            };
          }
        }

        const env = getEnvironmentConfig();
        res.json({
          meshtasticNodeIp: env.meshtasticNodeIp,
          meshtasticTcpPort: env.meshtasticTcpPort,
          meshtasticUseTls: false,
          baseUrl: env.baseUrl,
          deviceMetadata: deviceMetadata,
          localNodeInfo: localNodeInfo
        });
      } catch (error) {
        const env = getEnvironmentConfig();
        res.json({
          meshtasticNodeIp: env.meshtasticNodeIp,
          meshtasticTcpPort: env.meshtasticTcpPort,
          meshtasticUseTls: false,
          baseUrl: env.baseUrl
        });
      }
    });
  });

  beforeEach(() => {
    // Mock DatabaseService methods
    mockGetSetting = vi.spyOn(DatabaseService, 'getSetting');
    mockGetNode = vi.spyOn(DatabaseService, 'getNode');
  });

  describe('localNodeInfo for anonymous users', () => {
    it('should return localNodeInfo when localNodeNum is available', async () => {
      // Mock local node data
      mockGetSetting.mockReturnValue('2732916556');
      mockGetNode.mockReturnValue({
        nodeNum: 2732916556,
        nodeId: '!a2e175b8',
        longName: 'Test Node',
        shortName: 'TEST',
        firmwareVersion: '2.3.0',
        rebootCount: 5
      });

      const response = await request(app).get('/api/config');

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('localNodeInfo');
      expect(response.body.localNodeInfo).toEqual({
        nodeId: '!a2e175b8',
        longName: 'Test Node',
        shortName: 'TEST'
      });
      expect(response.body).toHaveProperty('deviceMetadata');
      expect(response.body.deviceMetadata).toEqual({
        firmwareVersion: '2.3.0',
        rebootCount: 5
      });
    });

    it('should handle missing localNodeNum gracefully', async () => {
      mockGetSetting.mockReturnValue(null);

      const response = await request(app).get('/api/config');

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('meshtasticNodeIp');
      expect(response.body).toHaveProperty('meshtasticTcpPort');
      expect(response.body.localNodeInfo).toBeUndefined();
      expect(response.body.deviceMetadata).toBeUndefined();
    });

    it('should handle missing node data gracefully', async () => {
      mockGetSetting.mockReturnValue('2732916556');
      mockGetNode.mockReturnValue(null);

      const response = await request(app).get('/api/config');

      expect(response.status).toBe(200);
      expect(response.body.localNodeInfo).toBeUndefined();
      expect(response.body.deviceMetadata).toBeUndefined();
    });

    it('should return base config even when database errors occur', async () => {
      mockGetSetting.mockImplementation(() => {
        throw new Error('Database error');
      });

      const response = await request(app).get('/api/config');

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('meshtasticNodeIp');
      expect(response.body).toHaveProperty('meshtasticTcpPort');
      expect(response.body).toHaveProperty('baseUrl');
      // Should not have localNodeInfo when error occurs
      expect(response.body.localNodeInfo).toBeUndefined();
    });

    it('should include all required fields in localNodeInfo', async () => {
      mockGetSetting.mockReturnValue('123456');
      mockGetNode.mockReturnValue({
        nodeNum: 123456,
        nodeId: '!00012345',
        longName: 'My Meshtastic Node',
        shortName: 'MN',
        firmwareVersion: '2.4.1',
        rebootCount: 10
      });

      const response = await request(app).get('/api/config');

      expect(response.status).toBe(200);
      expect(response.body.localNodeInfo).toHaveProperty('nodeId');
      expect(response.body.localNodeInfo).toHaveProperty('longName');
      expect(response.body.localNodeInfo).toHaveProperty('shortName');
      // Should NOT include internal fields like firmwareVersion or rebootCount
      expect(response.body.localNodeInfo).not.toHaveProperty('firmwareVersion');
      expect(response.body.localNodeInfo).not.toHaveProperty('rebootCount');
      expect(response.body.localNodeInfo).not.toHaveProperty('nodeNum');
    });
  });
});
