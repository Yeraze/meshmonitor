# MeshMonitor Architecture

This document provides a detailed overview of the MeshMonitor application architecture, design decisions, and implementation details.

## Overview

MeshMonitor is a full-stack web application designed to monitor and interact with Meshtastic mesh networks. The application follows a three-tier architecture with a React frontend, Express.js backend, and SQLite database.

```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   Browser       │    │   Express.js    │    │   SQLite        │
│   (React SPA)   │◄──►│   (API Server)  │◄──►│   (Database)    │
└─────────────────┘    └─────────────────┘    └─────────────────┘
                                │
                                ▼
                       ┌─────────────────┐
                       │  Meshtastic     │
                       │  Node (HTTP)    │
                       └─────────────────┘
```

## Frontend Architecture

### Technology Stack
- **React 18** with **TypeScript** for type safety
- **Vite** as the build tool for fast development and optimized builds
- **CSS3** with Catppuccin Mocha theme for modern, dark UI
- **ES Modules** for modern JavaScript features

### Key Components

#### App.tsx - Main Application Component
The core application component manages:
- Connection status to Meshtastic node
- Node data fetching and state management
- Message handling with iPhone Messages-style UI
- Channel management and filtering
- Real-time data updates via polling

#### State Management Strategy
- **React useState hooks** for local component state
- **Custom hooks** for data fetching logic
- **Map-based state** for pending message acknowledgments
- **Real-time polling** for backend synchronization

#### UI/UX Features
- **iPhone Messages-style bubbles** with proper alignment
- **Sender identification dots** with tooltips showing node names
- **Real-time delivery status** (⏳ pending → ✓ delivered)
- **Optimistic UI updates** for instant feedback
- **Responsive design** for mobile and desktop

### Data Flow

```
User Input → State Update → API Call → Backend Processing → Database → Response → UI Update
     ↓                                                                              ↑
Optimistic UI ←─────────────────────────────────────────────────────────────────────┘
```

## Backend Architecture

### Technology Stack
- **Node.js** with **Express.js** framework
- **TypeScript** for type safety and better developer experience
- **better-sqlite3** for high-performance SQLite operations
- **CORS** enabled for cross-origin requests

### Core Services

#### MeshtasticManager
**Location**: `src/server/meshtasticManager.ts`

The central service for Meshtastic node communication:
- **HTTP API Client** for Meshtastic node communication
- **Protobuf Message Parsing** for binary data interpretation
- **Real-time Polling** for continuous data synchronization
- **Channel Detection** with whitelist-based filtering
- **Node Discovery** and telemetry data extraction
- **Automatic Traceroute Scheduler** running every 3 minutes
- **Route Path Discovery** for network topology mapping

Key Methods:
```typescript
connect(): Promise<boolean>                    // Connect to Meshtastic node
sendTextMessage(text: string, channel: number) // Send messages
sendTraceroute(destination: string)            // Send traceroute request
getAllNodes(): DeviceInfo[]                    // Get node information
getRecentMessages(limit: number)               // Get message history
startTracerouteScheduler()                     // Start automatic traceroutes
```

Channel Management:
- **Whitelist-based filtering** prevents invalid channels
- **Known channels**: Primary, admin, gauntlet, telemetry, Secondary, LongFast, VeryLong
- **Automatic cleanup** of invalid channel entries

#### DatabaseService
**Location**: `src/services/database.ts`

Manages all SQLite database operations:
- **Node management** (create, read, update, delete)
- **Message persistence** with deduplication
- **Channel configuration** storage
- **Data cleanup utilities**
- **Export/import functionality**

Database Schema:
```sql
-- Nodes table
CREATE TABLE nodes (
  nodeNum INTEGER PRIMARY KEY,
  nodeId TEXT UNIQUE NOT NULL,
  longName TEXT,
  shortName TEXT,
  hwModel INTEGER,
  role INTEGER,
  hopsAway INTEGER,
  lastHeard INTEGER,
  snr REAL,
  rssi INTEGER,
  -- ... additional telemetry fields
);

-- Messages table
CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  fromNodeNum INTEGER NOT NULL,
  toNodeNum INTEGER NOT NULL,
  fromNodeId TEXT NOT NULL,
  toNodeId TEXT NOT NULL,
  text TEXT NOT NULL,
  channel INTEGER NOT NULL DEFAULT 0,
  timestamp INTEGER NOT NULL,
  -- ... FOREIGN KEY constraints
);

-- Channels table
CREATE TABLE channels (
  id INTEGER PRIMARY KEY,
  name TEXT,
  psk TEXT,
  uplinkEnabled BOOLEAN DEFAULT 1,
  downlinkEnabled BOOLEAN DEFAULT 1
);

-- Traceroutes table
CREATE TABLE traceroutes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fromNodeNum INTEGER NOT NULL,
  toNodeNum INTEGER NOT NULL,
  fromNodeId TEXT NOT NULL,
  toNodeId TEXT NOT NULL,
  route TEXT,
  routeBack TEXT,
  snrTowards TEXT,
  snrBack TEXT,
  timestamp INTEGER NOT NULL,
  createdAt INTEGER NOT NULL,
  FOREIGN KEY (fromNodeNum) REFERENCES nodes(nodeNum),
  FOREIGN KEY (toNodeNum) REFERENCES nodes(nodeNum)
);
```

### API Design

#### RESTful Endpoints

**Node Management**:
- `GET /api/nodes` - Retrieve all nodes
- `GET /api/nodes/active?days=7` - Get recently active nodes

**Message Operations**:
- `GET /api/messages?limit=100` - Get paginated messages
- `POST /api/messages/send` - Send message to channel
- `GET /api/messages/channel/:channel` - Channel-specific messages

**Traceroute Operations**:
- `GET /api/traceroutes/recent` - Get recent traceroutes with route paths
- `POST /api/traceroutes/send` - Send traceroute to specific node

**System Management**:
- `GET /api/health` - Health check endpoint
- `GET /api/connection` - Meshtastic connection status
- `POST /api/cleanup/channels` - Clean invalid channels

#### Error Handling
- Comprehensive try-catch blocks with logging
- HTTP status codes for different error types
- Graceful degradation when Meshtastic node is unreachable
- Database constraint handling

## Data Layer

### SQLite Database Design

#### Performance Optimizations
- **Indexes** on frequently queried columns (nodeId, timestamp, channel)
- **WAL mode** for better concurrent access
- **Foreign key constraints** for data integrity
- **Prepared statements** for SQL injection prevention

#### Data Integrity
- **UPSERT operations** for node data to handle duplicates
- **Timestamp-based sorting** for chronological message ordering
- **Node relationship validation** via foreign keys
- **Channel name normalization** and validation

## Meshtastic Integration

### Protocol Handling

#### HTTP API Communication
- **RESTful HTTP calls** to Meshtastic node
- **Binary protobuf parsing** for message decoding
- **Automatic reconnection** on connection failures
- **Configuration requests** for device setup

#### Protobuf Message Processing
```typescript
// Simplified protobuf parsing flow
Raw Binary Data → Field Extraction → Type Detection → Data Processing → Database Storage
```

Message Types Handled:
- **Node Information** (device details, telemetry)
- **Text Messages** (user communications)
- **Channel Configuration** (network settings)
- **Telemetry Data** (battery, GPS, signal strength)

#### Channel Management Strategy
- **Whitelist approach** for known Meshtastic channels
- **Automatic filtering** of WiFi SSIDs and random strings
- **Dynamic channel discovery** from legitimate sources
- **Channel cleanup utilities** for maintenance

## Security Considerations

### Backend Security
- **Input validation** on all API endpoints
- **SQL injection prevention** via prepared statements
- **CORS configuration** for controlled access
- **Environment-based configuration** for sensitive data

### Frontend Security
- **TypeScript** for compile-time error prevention
- **Output sanitization** for user-generated content
- **Secure HTTP connections** support via TLS configuration

## Deployment Architecture

### Docker Containerization
```dockerfile
# Multi-stage build for optimized production image
FROM node:20-alpine AS builder
# Build both frontend and backend
RUN npm run build && npm run build:server

FROM node:20-alpine AS production
# Copy only built assets and production dependencies
```

### Production Configuration
- **Volume mounting** for persistent database storage
- **Environment variables** for configuration management
- **Health checks** for container orchestration
- **Graceful shutdown** handling for data integrity

## Performance Considerations

### Frontend Optimizations
- **React.memo** for component optimization
- **Efficient re-renders** via proper state management
- **Optimistic updates** for perceived performance
- **Lazy loading** for large node lists

### Backend Optimizations
- **Connection pooling** for database operations
- **Efficient polling** with configurable intervals
- **Memory management** for protobuf parsing
- **Caching strategies** for frequently accessed data

### Database Optimizations
- **Query optimization** with proper indexing
- **Batch operations** for bulk data processing
- **Regular cleanup** of old data
- **Database maintenance** utilities

## Monitoring and Observability

### Logging Strategy
- **Structured logging** with different levels
- **Request/response logging** for API calls
- **Error tracking** with stack traces
- **Performance metrics** for optimization

### Health Monitoring
- **Connection status** monitoring
- **Database health** checks
- **Memory and CPU** usage tracking
- **Error rate** monitoring

## Development Workflow

### Build Process
```bash
# Development
npm run dev:full    # Start both frontend and backend in dev mode

# Production
npm run build       # Build frontend assets
npm run build:server # Compile TypeScript backend
npm start          # Start production server
```

### Code Quality
- **TypeScript** for type safety
- **ESLint** for code quality
- **Consistent formatting** standards
- **Git hooks** for pre-commit validation

## Traceroute Scheduler

### Automatic Network Discovery

The MeshMonitor application includes an intelligent traceroute scheduler that automatically discovers network topology:

**Scheduling Logic:**
- Runs every 3 minutes when connected to a Meshtastic node
- Selects nodes that either have no traceroute data or oldest traceroute
- Automatically sends traceroute requests to discover routes
- Stores complete route paths with SNR data for each hop

**Data Collection:**
- Route paths (both forward and return routes)
- SNR values for each hop in the path
- Timestamp for traceroute completion
- Node-to-node relationship mapping

**Filtering:**
- Traceroute messages are filtered from Primary channel display
- Prevents clutter while maintaining network discovery
- Data stored in dedicated traceroutes table

## Map Visualization

### Route Display Features

**Interactive Route Mapping:**
- "Show Routes" checkbox to toggle route display
- Weighted polylines showing route segments
- Thickness varies from 2-8px based on segment usage
- Routes that appear in multiple traceroutes are drawn thicker
- Purple color scheme matching Catppuccin theme

**Segment Weight Calculation:**
- Base weight: 2px
- Additional weight: +1px per usage occurrence
- Maximum weight: 8px for heavily used routes
- Bidirectional segments counted once (normalized)

## Future Enhancements

### Planned Improvements
1. **Enhanced Telemetry Parsing** - More sophisticated protobuf decoding
2. **Real-time WebSocket Updates** - Replace polling with WebSocket connections
3. **Advanced Channel Management** - Custom channel creation and management
4. **Message Search** - Full-text search across message history
5. **Data Visualization** - Charts and graphs for network analytics
6. **Mobile App** - React Native companion application
7. **Advanced Traceroute Analytics** - Network path optimization and analysis

### Scalability Considerations
- **Database migration** to PostgreSQL for larger deployments
- **Horizontal scaling** with load balancers
- **Caching layer** with Redis for improved performance
- **Microservices architecture** for complex deployments

---

This architecture supports MeshMonitor's current capabilities while providing a foundation for future enhancements and scalability improvements.