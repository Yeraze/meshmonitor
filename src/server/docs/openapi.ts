/**
 * OpenAPI Configuration
 *
 * Defines the OpenAPI 3.0 specification for the MeshMonitor API v1
 */

import swaggerJsdoc from 'swagger-jsdoc';
import { getEnvironmentConfig } from '../config/environment.js';

const env = getEnvironmentConfig();
const baseUrl = env.baseUrl || '';

const options: swaggerJsdoc.Options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'MeshMonitor API',
      version: '1.0.0',
      description: `
# MeshMonitor External API

Read-only API for accessing MeshMonitor data programmatically.

## Authentication

All API endpoints require authentication via API key. Include your API key in the Authorization header:

\`\`\`
Authorization: Bearer mm_your_api_key_here
\`\`\`

You can generate an API key from the MeshMonitor Settings page.

## Rate Limiting

API requests are rate limited to 100 requests per 15 minutes per API key.

Rate limit information is included in response headers:
- \`X-RateLimit-Limit\`: Maximum requests allowed in the time window
- \`X-RateLimit-Remaining\`: Requests remaining in current window
- \`X-RateLimit-Reset\`: Unix timestamp when the rate limit resets

## Permissions

API keys inherit the permissions of the user who created them. If you don't have permission to access a resource via the web interface, you won't be able to access it via the API.

## Response Format

All responses are in JSON format. Successful responses include a 2xx status code. Errors include a 4xx or 5xx status code with an error message.

## Versioning

The API is versioned using URL path versioning (/api/v1/*). This ensures backwards compatibility as the API evolves.
      `,
      contact: {
        name: 'MeshMonitor',
        url: 'https://github.com/Yeraze/meshmonitor'
      },
      license: {
        name: 'BSD-3-Clause',
        url: 'https://opensource.org/licenses/BSD-3-Clause'
      }
    },
    servers: [
      {
        url: `${baseUrl}/api/v1`,
        description: 'API v1'
      }
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'API Key',
          description: 'API key authentication. Format: Bearer mm_your_api_key_here'
        }
      },
      schemas: {
        Error: {
          type: 'object',
          required: ['error'],
          properties: {
            error: {
              type: 'string',
              description: 'Error message'
            },
            message: {
              type: 'string',
              description: 'Detailed error message'
            }
          }
        },
        Node: {
          type: 'object',
          properties: {
            num: { type: 'number', description: 'Node number' },
            user: {
              type: 'object',
              properties: {
                id: { type: 'string', description: 'Node ID (hex format)' },
                longName: { type: 'string', description: 'Long name' },
                shortName: { type: 'string', description: 'Short name' },
                hwModel: { type: 'number', description: 'Hardware model' },
                role: { type: 'number', description: 'Node role' }
              }
            },
            position: {
              type: 'object',
              nullable: true,
              properties: {
                latitude: { type: 'number', description: 'Latitude' },
                longitude: { type: 'number', description: 'Longitude' },
                altitude: { type: 'number', description: 'Altitude in meters' }
              }
            },
            snr: { type: 'number', nullable: true, description: 'Signal-to-noise ratio' },
            rssi: { type: 'number', nullable: true, description: 'Received signal strength' },
            lastHeard: { type: 'number', description: 'Unix timestamp of last contact' },
            hopsAway: { type: 'number', nullable: true, description: 'Network hops from gateway' },
            isFavorite: { type: 'boolean', description: 'User favorite flag' }
          }
        },
        Message: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Message ID' },
            from: { type: 'string', description: 'Sender node ID' },
            to: { type: 'string', description: 'Recipient node ID' },
            text: { type: 'string', description: 'Message text' },
            channel: { type: 'number', description: 'Channel index' },
            timestamp: { type: 'string', format: 'date-time', description: 'Message timestamp' },
            portnum: { type: 'number', description: 'Port number' }
          }
        },
        Channel: {
          type: 'object',
          properties: {
            id: { type: 'number', description: 'Channel index' },
            name: { type: 'string', description: 'Channel name' },
            uplinkEnabled: { type: 'boolean' },
            downlinkEnabled: { type: 'boolean' }
          }
        },
        Stats: {
          type: 'object',
          properties: {
            totalNodes: { type: 'number' },
            totalMessages: { type: 'number' },
            nodesSeenLast24h: { type: 'number' },
            messagesLast24h: { type: 'number' }
          }
        }
      },
      responses: {
        UnauthorizedError: {
          description: 'API key is missing or invalid',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/Error' },
              example: {
                error: 'Invalid or inactive API key'
              }
            }
          }
        },
        ForbiddenError: {
          description: 'Insufficient permissions',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/Error' },
              example: {
                error: 'Insufficient permissions to access this resource'
              }
            }
          }
        },
        NotFoundError: {
          description: 'Resource not found',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/Error' },
              example: {
                error: 'Resource not found'
              }
            }
          }
        },
        RateLimitError: {
          description: 'Rate limit exceeded',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/Error' },
              example: {
                error: 'Rate limit exceeded. Please try again later.'
              }
            }
          }
        },
        ServerError: {
          description: 'Internal server error',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/Error' },
              example: {
                error: 'Internal server error'
              }
            }
          }
        }
      }
    },
    security: [
      {
        bearerAuth: []
      }
    ],
    tags: [
      {
        name: 'Nodes',
        description: 'Mesh node information and management'
      },
      {
        name: 'Messages',
        description: 'Message history and communication'
      },
      {
        name: 'Channels',
        description: 'Channel configuration and information'
      },
      {
        name: 'Stats',
        description: 'Network statistics and metrics'
      },
      {
        name: 'Telemetry',
        description: 'Node telemetry data'
      },
      {
        name: 'System',
        description: 'System health and status'
      }
    ]
  },
  // Path to the API routes with JSDoc comments
  apis: [
    './src/server/routes/v1/*.ts',
    './dist/server/routes/v1/*.js'
  ]
};

export const swaggerSpec = swaggerJsdoc(options);
