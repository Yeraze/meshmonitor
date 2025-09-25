# MeshMonitor System Architecture

## Overview

MeshMonitor is a full-stack web application designed to monitor Meshtastic mesh networks over IP. The system follows a modern three-tier architecture with a React frontend, Node.js/Express backend, and SQLite database.

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        MeshMonitor System                       │
├─────────────────────────────────────────────────────────────────┤
│  ┌─────────────────┐    ┌─────────────────┐    ┌─────────────┐  │
│  │   React App     │────│   Express API   │────│  SQLite DB  │  │
│  │  (Frontend)     │    │   (Backend)     │    │(Persistence)│  │
│  └─────────────────┘    └─────────────────┘    └─────────────┘  │
│           │                        │                     │      │
│           │                        │                     │      │
│           └────────────────────────┼─────────────────────┘      │
│                                    │                            │
│                       ┌─────────────────┐                      │
│                       │ Meshtastic Node │                      │
│                       │   (HTTP API)    │                      │
│                       └─────────────────┘                      │
└─────────────────────────────────────────────────────────────────┘
```

## Component Architecture

### 1. Frontend Layer (React Application)

**Technology Stack:**
- React 18 with TypeScript
- Vite for build tooling
- CSS3 with Catppuccin Mocha theme
- Modern ES modules

**Key Components:**
```
src/
├── App.tsx                 # Main application component
├── App.css                 # Catppuccin theme styles
├── services/
│   └── meshtasticService.ts # Meshtastic API client
└── main.tsx               # Application entry point
```

**Responsibilities:**
- User interface rendering and interaction
- Real-time connection status display
- Message composition and display
- Node information visualization
- Client-side state management

**Data Flow:**
1. User interactions trigger service calls
2. MeshtasticService handles HTTP API communication
3. Local state updates trigger UI re-renders
4. Real-time polling maintains data freshness

### 2. Backend Layer (Express API Server)

**Technology Stack:**
- Node.js with Express framework
- TypeScript for type safety
- CORS for cross-origin requests
- Compression and security middleware

**Key Components:**
```
src/server/
└── server.ts              # Express server with API routes
```

**API Design:**
- RESTful endpoints following OpenAPI standards
- JSON request/response format
- Error handling and validation
- Static file serving for production

**Responsibilities:**
- Serve React application static files
- Provide REST API for database operations
- Handle data export/import operations
- Manage database connections and transactions

### 3. Data Layer (SQLite Database)

**Technology Stack:**
- SQLite with better-sqlite3 driver
- WAL mode for better concurrency
- Foreign key constraints enabled
- Comprehensive indexing strategy

**Database Service:**
```
src/services/
└── database.ts            # Database service and schema
```

**Responsibilities:**
- Persistent storage of messages and node information
- Data deduplication and integrity
- Query optimization and performance
- Backup and restore functionality

## Data Architecture

### Core Data Entities

```mermaid
erDiagram
    NODES {
        int nodeNum PK
        string nodeId UNIQUE
        string longName
        string shortName
        int hwModel
        string macaddr
        real latitude
        real longitude
        real altitude
        int batteryLevel
        real voltage
        real channelUtilization
        real airUtilTx
        int lastHeard
        real snr
        int rssi
        int createdAt
        int updatedAt
    }

    MESSAGES {
        string id PK
        int fromNodeNum FK
        int toNodeNum FK
        string fromNodeId
        string toNodeId
        string text
        int channel
        int portnum
        int timestamp
        int rxTime
        int createdAt
    }

    CHANNELS {
        int id PK
        string name
        string psk
        boolean uplinkEnabled
        boolean downlinkEnabled
        int createdAt
        int updatedAt
    }

    NODES ||--o{ MESSAGES : sends
    NODES ||--o{ MESSAGES : receives
```

### Data Flow Patterns

**1. Message Processing Pipeline:**
```
Meshtastic Node → HTTP API → MeshtasticService → Database → Frontend
```

**2. Node Discovery Flow:**
```
Polling Loop → FromRadio Packets → Node Info Processing → Database Update → UI Refresh
```

**3. User Message Sending:**
```
UI Input → MeshtasticService → ToRadio API → Meshtastic Network
```

## Integration Architecture

### Meshtastic HTTP API Integration

**Connection Pattern:**
```typescript
// Initial handshake sequence
1. Send want_config_id protobuf
2. Receive node database via fromradio endpoint
3. Receive radio configuration
4. Start continuous polling loop
```

**Packet Processing:**
- **NodeInfo packets**: Device information and user details
- **Position packets**: GPS coordinates and altitude
- **Telemetry packets**: Battery, voltage, and radio metrics
- **Text Message packets**: User communications

**Error Handling:**
- Connection retry logic with exponential backoff
- Graceful degradation on API failures
- Local caching during network interruptions

### Real-time Updates

**Polling Strategy:**
- 2-second intervals for optimal balance
- Configurable fetch intervals
- Automatic connection health monitoring

**State Synchronization:**
- In-memory cache for active session data
- Database persistence for historical data
- Optimistic UI updates with rollback capability

## Security Architecture

### Network Security
- HTTPS/TLS support for encrypted communication
- CORS configuration for cross-origin protection
- Request rate limiting and validation

### Data Security
- SQL injection prevention with prepared statements
- Input sanitization and validation
- No sensitive credential storage

### Container Security
- Non-root user execution in Docker
- Minimal container surface area
- Read-only filesystem where possible

## Scalability Considerations

### Current Limitations
- Single SQLite database instance
- In-memory caching for active data
- Single Meshtastic node connection

### Future Scaling Options
- Database connection pooling
- Redis for distributed caching
- Multiple node support with load balancing
- WebSocket connections for real-time updates

## Performance Architecture

### Database Optimization
- Comprehensive indexing on query columns
- WAL mode for concurrent reads/writes
- Periodic VACUUM operations
- Query result pagination

### Frontend Performance
- React component memoization
- Efficient re-rendering with keys
- Lazy loading for large datasets
- CSS-based animations (GPU accelerated)

### Backend Performance
- Express.js with compression middleware
- Efficient SQL query patterns
- Response caching headers
- Optimized Docker builds

## Deployment Architecture

### Development Environment
```
┌─────────────────┐    ┌─────────────────┐
│  Vite Dev       │    │  Express Dev    │
│  Server         │    │  Server         │
│  (Port 5173)    │    │  (Port 3001)    │
└─────────────────┘    └─────────────────┘
```

### Production Environment
```
┌─────────────────────────────────────┐
│           Docker Container           │
├─────────────────────────────────────┤
│  ┌─────────────────────────────────┐ │
│  │        Express Server           │ │
│  │    (Static Files + API)         │ │
│  │         (Port 3001)             │ │
│  └─────────────────────────────────┘ │
│  ┌─────────────────────────────────┐ │
│  │        SQLite Database          │ │
│  │       (/data volume)            │ │
│  └─────────────────────────────────┘ │
└─────────────────────────────────────┘
```

### Docker Architecture
- **Multi-stage builds**: Separate build and runtime environments
- **Volume mounting**: Persistent data storage
- **Environment configuration**: Runtime parameter injection
- **Health checks**: Container monitoring and recovery

## Monitoring and Observability

### Logging Strategy
- Structured logging with timestamps
- Different log levels (debug, info, warn, error)
- Request/response logging for API endpoints
- Database operation logging

### Health Monitoring
- `/api/health` endpoint for system status
- Database connection monitoring
- Meshtastic node connectivity checks
- Container resource utilization

### Error Tracking
- Graceful error handling at all layers
- User-friendly error messages
- Detailed error logging for debugging
- Automatic error recovery where possible

## Development Workflow

### Build Process
1. **TypeScript Compilation**: Source code type checking
2. **React Build**: Production bundle creation with Vite
3. **Server Build**: Express application compilation
4. **Docker Build**: Container image creation
5. **Testing**: Automated test execution

### Deployment Process
1. **Environment Preparation**: Configuration setup
2. **Database Migration**: Schema updates if needed
3. **Application Deployment**: Container startup
4. **Health Verification**: System status checks
5. **Monitoring Setup**: Log and metric collection

This architecture provides a solid foundation for monitoring Meshtastic mesh networks with room for future enhancements and scaling.