# MeshMonitor Test Suite

## Overview
A comprehensive test suite has been implemented for MeshMonitor using Vitest as the testing framework. The suite covers database operations, API endpoints, and frontend components.

## Test Structure

### 1. Database Tests (`src/services/database.test.ts`)
- **Node Operations**: CRUD operations for node management
- **Message Operations**: Message storage and retrieval
- **Channel Operations**: Channel management functionality
- **Telemetry Operations**: Telemetry data storage
- **Traceroute Operations**: Network path tracking
- **Cleanup Operations**: Data purging functionality
- **Favorite Operations**: Node favorite status management, sync from NodeInfo protobuf

### 2. Server API Tests (`src/server/server.test.ts`)
- **Node Endpoints**: `/api/nodes`, `/api/nodes/active`
- **Message Endpoints**: Message sending, retrieval, and filtering
- **Channel Endpoints**: Channel listing and management
- **Statistics Endpoints**: System metrics and analytics
- **Health Endpoints**: System status checks
- **Import/Export**: Data backup and restore
- **Cleanup Endpoints**: Data maintenance operations
- **Telemetry Endpoints**: Telemetry data access
- **Traceroute Endpoints**: Network analysis operations

### 3. Component Tests (`src/components/TelemetryGraphs.test.tsx`)
- UI rendering tests
- Data fetching behavior
- User interaction handling
- Error state management
- Loading state verification
- Data visualization tests

## Running Tests

```bash
# Run all tests once
npm run test:run

# Run tests in watch mode
npm run test

# Run tests with UI
npm run test:ui

# Generate coverage report
npm run test:coverage
```

## Testing Stack

- **Framework**: Vitest
- **React Testing**: @testing-library/react
- **API Testing**: Supertest
- **Assertions**: @testing-library/jest-dom
- **User Events**: @testing-library/user-event

## Coverage Areas

### Database Layer
✅ Node CRUD operations
✅ Message storage and retrieval
✅ Channel management
✅ Telemetry data handling
✅ Traceroute tracking
✅ Data cleanup operations
✅ Favorite node management
✅ NodeInfo protobuf favorite sync

### API Layer
✅ RESTful endpoints
✅ Error handling
✅ Request validation
✅ Response formatting
✅ Authentication checks
✅ Data export/import

### Frontend Components
✅ Component rendering
✅ State management
✅ User interactions
✅ Data fetching
✅ Error boundaries
✅ Loading states

## Mock Strategy

The test suite uses comprehensive mocking to ensure tests are isolated and predictable:

1. **Database Mocking**: In-memory SQLite for database tests
2. **API Mocking**: Mock Express app with stubbed database calls
3. **Network Mocking**: Mocked fetch API for component tests
4. **Component Mocking**: Mocked chart libraries to avoid rendering issues

## Best Practices Implemented

1. **Test Isolation**: Each test runs independently
2. **Descriptive Names**: Clear test descriptions
3. **Arrange-Act-Assert**: Consistent test structure
4. **Error Testing**: Both success and failure paths tested
5. **Edge Cases**: Boundary conditions and edge cases covered
6. **Mocking Strategy**: Appropriate mocking at each layer

## Future Enhancements

1. **Integration Tests**: End-to-end testing with real database
2. **Performance Tests**: Load testing for API endpoints
3. **Snapshot Testing**: UI component snapshot tests
4. **Mutation Testing**: Test quality verification
5. **Security Tests**: Authentication and authorization testing
6. **WebSocket Tests**: Real-time communication testing

## CI/CD Integration

The test suite is ready for CI/CD integration:

```yaml
# Example GitHub Actions workflow
- name: Run Tests
  run: npm run test:run

- name: Generate Coverage
  run: npm run test:coverage

- name: Upload Coverage
  uses: codecov/codecov-action@v3
```

## Known Issues

- Some tests may need adjustment for Node.js version compatibility
- jsdom environment required for component tests
- Database mock may need refinement for complex queries

## Maintenance

Regular test maintenance should include:
- Updating tests when features change
- Adding tests for new features
- Reviewing and updating mocks
- Monitoring test execution time
- Maintaining test coverage above 80%