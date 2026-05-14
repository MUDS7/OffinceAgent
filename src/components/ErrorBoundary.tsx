import { Component } from "react";
import type { ErrorInfo, ReactNode } from "react";

type ErrorBoundaryProps = {
  children: ReactNode;
};

type ErrorBoundaryState = {
  error: Error | null;
};

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("ErrorBoundary caught an error:", error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <main className="desktop-shell">
          <section className="error-boundary-fallback">
            <h2>页面发生错误</h2>
            <p>请刷新页面重试。如果问题持续存在，请检查控制台日志。</p>
            <pre className="error-boundary-message">{this.state.error.message}</pre>
            <button
              type="button"
              onClick={() => {
                this.setState({ error: null });
              }}
            >
              重试
            </button>
          </section>
        </main>
      );
    }

    return this.props.children;
  }
}
