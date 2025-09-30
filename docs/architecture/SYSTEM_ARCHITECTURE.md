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
- React 19 with TypeScript
- Vite for build tooling
- CSS3 with Catppuccin Mocha theme
- Modern ES modules

**Key Components:**
```
src/
├── App.tsx                 # Main application component
├── App.css                 # Catppuccin theme styles
├── components/
│   ├── TelemetryGraphs.tsx # Telemetry visualization component
│   └── TelemetryGraphs.css # Telemetry graph styles
├── main.tsx               # Application entry point
└── services/
    └── database.ts        # Database service (shared)
```

**Responsibilities:**
- User interface rendering and interaction
- Real-time connection status display
- Message composition and display
- Node information visualization with map integration
- Telemetry data visualization with graphs
- Traceroute visualization and management
- Channel management interface
- Client-side state management

**Data Flow:**
1. User interactions trigger API calls to Express backend
2. Backend communicates with Meshtastic node via HTTP/Protobuf
3. Database persists all node, message, and telemetry data
4. Frontend polls backend for updates every 2 seconds
5. Local state updates trigger UI re-renders
6. Map and telemetry graphs update in real-time

### 2. Backend Layer (Express API Server)

**Technology Stack:**
- Node.js with Express framework
- TypeScript for type safety
- CORS for cross-origin requests
- Compression and security middleware

**Key Components:**
```
src/server/
├── server.ts                     # Express server with API routes
├── meshtasticManager.ts          # Meshtastic connection manager
├── meshtasticProtobufService.ts # Protobuf message handling
├── protobufService.ts           # Core protobuf serialization
└── protobufLoader.ts            # Protobuf schema loader
```

**API Design:**
- RESTful endpoints following OpenAPI standards
- JSON request/response format
- Protobuf message handling for Meshtastic communication
- WebSocket-like polling for real-time updates
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

**Schema includes:**
- **nodes**: Device information and telemetry
- **messages**: Text messages and communications
- **channels**: Channel configuration
- **telemetry**: Time-series telemetry data
- **traceroutes**: Network path analysis

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
        nodeNum int PK
        nodeId string "UNIQUE"
        longName string
        shortName string
        hwModel int
        role int
        hopsAway int
        macaddr string
        latitude real
        longitude real
        altitude real
        batteryLevel int
        voltage real
        channelUtilization real
        airUtilTx real
        lastHeard int
        snr real
        rssi int
        lastTracerouteRequest int
        createdAt int
        updatedAt int
    }

    MESSAGES {
        id string PK
        fromNodeNum int FK
        toNodeNum int FK
        fromNodeId string
        toNodeId string
        text string
        channel int
        portnum int
        timestamp int
        rxTime int
        hopStart int
        hopLimit int
        replyId int
        emoji int
        createdAt int
    }

    CHANNELS {
        id int PK
        name string
        psk string
        uplinkEnabled boolean
        downlinkEnabled boolean
        createdAt int
        updatedAt int
    }

    TELEMETRY {
        id int PK
        nodeId string
        nodeNum int FK
        telemetryType string
        timestamp int
        value real
        unit string
        createdAt int
    }

    TRACEROUTES {
        id int PK
        fromNodeNum int FK
        toNodeNum int FK
        fromNodeId string
        toNodeId string
        route string
        routeBack string
        snrTowards string
        snrBack string
        timestamp int
        createdAt int
    }

    NODES ||--o{ MESSAGES : sends
    NODES ||--o{ MESSAGES : receives
    NODES ||--o{ TELEMETRY : generates
    NODES ||--o{ TRACEROUTES : initiates
    NODES ||--o{ TRACEROUTES : targets
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
- **NodeInfo packets**: Device information, user details, and role configuration
- **Position packets**: GPS coordinates, altitude, and location timestamps
- **Telemetry packets**: Battery level, voltage, channel utilization, air utilization
- **Text Message packets**: User communications with emoji support
- **Traceroute packets**: Network path analysis and SNR measurements
- **Admin packets**: Channel configuration and node management

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

### Current Design
- Single SQLite database instance with WAL mode for concurrency
- In-memory caching for active session data
- Single Meshtastic node connection via HTTP API
- Telemetry data retention with configurable cleanup
- Traceroute automation for network topology mapping

### Future Scaling Options
- Database connection pooling for higher concurrency
- Redis for distributed caching across instances
- Multiple node support with load balancing
- WebSocket connections for real-time updates
- Time-series database for telemetry data
- GraphQL API for flexible data queries

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
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│  Vite Dev       │    │  Express Dev    │    │  Meshtastic     │
│  Server         │    │  Server         │    │  Node           │
│  (Port 5173)    │    │  (Port 3001)    │    │  (HTTP API)     │
└─────────────────┘    └─────────────────┘    └─────────────────┘
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

## Feature Architecture

### Telemetry System
The application tracks and visualizes various telemetry metrics:
- **Battery Monitoring**: Tracks battery level and voltage over time
- **Channel Utilization**: Monitors radio channel usage
- **Air Utilization**: Tracks transmit air time utilization
- **SNR/RSSI Tracking**: Signal quality metrics for network analysis
- **Time-series Storage**: Efficient storage with periodic cleanup

### Traceroute System
Automated network topology discovery:
- **Automatic Traceroute**: Periodically discovers network paths
- **Bidirectional Analysis**: Tracks routes in both directions
- **SNR Mapping**: Records signal quality along each hop
- **Route Visualization**: Display network paths on the map
- **Historical Tracking**: Maintains route history for analysis

### Channel Management
Multi-channel support for Meshtastic networks:
- **Primary Channel**: Default channel 0 for main communications
- **Named Channels**: Support for admin, secondary, and custom channels
- **Channel Configuration**: PSK and uplink/downlink settings
- **Message Routing**: Automatic routing to appropriate channels

## Development Workflow

### Build Process
1. **TypeScript Compilation**: Source code type checking for both frontend and backend
2. **React Build**: Production bundle creation with Vite, including code splitting
3. **Server Build**: Express application compilation with protobuf support
4. **Docker Build**: Multi-stage container image creation
5. **Database Migration**: Automatic schema updates on startup

### Deployment Process
1. **Environment Preparation**: Configuration setup
2. **Database Migration**: Schema updates if needed
3. **Application Deployment**: Container startup
4. **Health Verification**: System status checks
5. **Monitoring Setup**: Log and metric collection

This architecture provides a solid foundation for monitoring Meshtastic mesh networks with room for future enhancements and scaling.