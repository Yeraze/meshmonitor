import React, { Component, ErrorInfo } from 'react';
import { logger } from '../../utils/logger';
import { describeError } from './describeError';
import './ErrorBoundary.css';

interface ErrorBoundaryProps {
  children: React.ReactNode;
  fallbackTitle?: string;
  /** Replaces the default panel. Gets the thrown value and a `retry` that
   *  re-renders the children. Use it where the default panel does not fit:
   *  a map's box (`BaseMap`), or the whole page (`main.tsx`). */
  fallback?: (error: unknown, retry: () => void) => React.ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  /** Whatever was thrown. Usually an `Error`, but libraries can throw plain
   *  strings (leaflet.markercluster does, #5516). */
  error: unknown;
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
      if (this.props.fallback) {
        return this.props.fallback(this.state.error, this.handleRetry);
      }
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
