/**
 * Mock OIDC Provider for Testing
 *
 * Simple OIDC provider with pre-configured test users
 */

import express from 'express';
import Provider from 'oidc-provider';

const PORT = process.env.PORT || 3000;
const ISSUER = process.env.ISSUER || `http://localhost:${PORT}`;

// Mock user database
const users = [
  {
    id: 'test-user-1',
    email: 'alice@example.com',
    name: 'Alice Test',
    preferred_username: 'alice',
    // Password: 'password123'
    password: 'password123'
  },
  {
    id: 'test-user-2',
    email: 'bob@example.com',
    name: 'Bob Test',
    preferred_username: 'bob',
    password: 'password456'
  }
];

// Mock client configuration
const clients = [
  {
    client_id: 'meshmonitor-test',
    client_secret: 'test-secret-12345',
    redirect_uris: [
      'http://localhost:8085/api/auth/oidc/callback',
      'https://meshdev.yeraze.online/api/auth/oidc/callback',
      'https://oidc-mock.yeraze.online/api/auth/oidc/callback'
    ],
    grant_types: ['authorization_code'],
    response_types: ['code'],
    token_endpoint_auth_method: 'client_secret_post'
  }
];

// OIDC Provider configuration
const configuration = {
  clients,
  claims: {
    openid: ['sub'],
    email: ['email'],
    profile: ['name', 'preferred_username']
  },
  features: {
    devInteractions: { enabled: false },
    encryption: { enabled: false },
    introspection: { enabled: true },
    revocation: { enabled: true }
  },
  // Trust proxy for correct URL generation behind reverse proxy
  proxy: true,
  pkce: {
    methods: ['S256'],
    required: () => true  // Always require PKCE
  },
  ttl: {
    AccessToken: 3600,
    AuthorizationCode: 600,
    IdToken: 3600,
    RefreshToken: 86400
  },
  // Mock account/interaction handlers
  async findAccount(ctx, sub) {
    const user = users.find(u => u.id === sub);
    if (!user) return undefined;

    return {
      accountId: sub,
      async claims() {
        return {
          sub: user.id,
          email: user.email,
          name: user.name,
          preferred_username: user.preferred_username
        };
      }
    };
  },
  // Simple interaction handler for automatic login (testing only!)
  interactions: {
    url(ctx, interaction) {
      return `/interaction/${interaction.uid}`;
    }
  }
};

// Create Express app
const app = express();

// Trust proxy to handle X-Forwarded-* headers correctly
app.set('trust proxy', true);

// Force HTTPS protocol for all requests when behind reverse proxy
app.use((req, res, next) => {
  // Force HTTPS protocol if the ISSUER expects HTTPS
  if (ISSUER.startsWith('https://')) {
    // Ensure X-Forwarded-Proto is set
    req.headers['x-forwarded-proto'] = 'https';

    // Force Express to recognize this as a secure HTTPS connection
    Object.defineProperty(req, 'secure', {
      get: function() { return true; },
      set: function() {},
      configurable: true
    });
    Object.defineProperty(req, 'protocol', {
      get: function() { return 'https'; },
      set: function() {},
      configurable: true
    });

    // Also force connection to appear encrypted
    if (req.connection) {
      Object.defineProperty(req.connection, 'encrypted', {
        get: function() { return true; },
        set: function() {},
        configurable: true
      });
    }
  }
  next();
});

app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// Create OIDC provider
const provider = new Provider(ISSUER, configuration);

// Auto-login endpoint (for testing only!)
// This bypasses the normal login flow and immediately grants authorization
app.get('/interaction/:uid', async (req, res, next) => {
  try {
    const details = await provider.interactionDetails(req, res);
    const { uid, prompt, params } = details;

    // Auto-login as first user (alice)
    const user = users[0];

    // Grant authorization
    const grant = new provider.Grant({
      accountId: user.id,
      clientId: params.client_id
    });

    // Add all requested claims
    grant.addOIDCScope('openid email profile');
    const grantId = await grant.save();

    const result = {
      login: {
        accountId: user.id
      },
      consent: {
        grantId
      }
    };

    await provider.interactionFinished(req, res, result, {
      mergeWithLastSubmission: false
    });
  } catch (err) {
    next(err);
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    issuer: ISSUER,
    users: users.map(u => ({ id: u.id, email: u.email, name: u.name }))
  });
});

// Mount OIDC provider
app.use('/', provider.callback());

// Error handler
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(err.status || 500).json({
    error: err.message || 'Internal server error'
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`🔐 Mock OIDC Provider running at ${ISSUER}`);
  console.log(`📋 Discovery: ${ISSUER}/.well-known/openid-configuration`);
  console.log(`👤 Test users:`);
  users.forEach(u => {
    console.log(`   - ${u.email} (${u.name}) - password: ${u.password}`);
  });
  console.log(`🔑 Test client: meshmonitor-test / test-secret-12345`);
});
