import React, { Component, ErrorInfo } from 'react';
import { logger } from '../../utils/logger';
import './ErrorBoundary.css';

interface ErrorBoundaryProps {
  children: React.ReactNode;
  fallbackTitle?: string;
}

interface ErrorBoundaryState {
  hasError: boolean;
  /** Whatever was thrown. Usually an `Error`, but libraries can throw plain
   *  strings (leaflet.markercluster does, #5516). */
  error: unknown;
}

/** Readable text for a thrown value, whether or not it is an `Error`. */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: unknown, errorInfo: ErrorInfo) {
    logger.error('ErrorBoundary caught an error:', error, errorInfo);
  }

  handleRetry = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="error-boundary-fallback">
          <div className="error-boundary-content">
            <h2>{this.props.fallbackTitle || 'Something went wrong'}</h2>
            <p>An unexpected error occurred in this section.</p>
            {this.state.error != null && (
              <details className="error-boundary-details">
                <summary>Error details</summary>
                <pre>{describeError(this.state.error)}</pre>
              </details>
            )}
            <button className="error-boundary-retry" onClick={this.handleRetry}>
              Try Again
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

export default ErrorBoundary;
