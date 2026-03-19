import { Component, type ReactNode } from "react";
import ReactDOM from "react-dom/client";
import "./index.css";
import App from "./App";

class AppErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(err: unknown) {
    return { error: err instanceof Error ? err : new Error(String(err)) };
  }

  componentDidCatch(error: unknown) {
    console.error("[App] crashed:", error);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-slate-100 p-8">
          <h1 className="text-xl font-semibold text-slate-800">Something went wrong</h1>
          <pre className="max-w-2xl overflow-auto rounded-lg bg-slate-200 p-4 text-left text-sm text-red-700">
            {this.state.error.message}
          </pre>
          <button
            type="button"
            className="rounded-lg bg-slate-700 px-4 py-2 text-white hover:bg-slate-800"
            onClick={() => window.location.reload()}
          >
            Reload
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <AppErrorBoundary>
    <App />
  </AppErrorBoundary>,
);
