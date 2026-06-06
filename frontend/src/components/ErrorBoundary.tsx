import { Component, type ReactNode } from 'react';
import { ErrorModal } from './ErrorModal';

interface Props {
  children: ReactNode;
}
interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error(error);
  }

  render() {
    if (this.state.error) {
      return (
        <ErrorModal
          open
          title="Something went wrong"
          message="The error has been logged."
          actions={
            <button
              type="button"
              className="btn btn-primary"
              data-modal-role="primary"
              onClick={() => window.location.reload()}
            >
              Reload
            </button>
          }
          onClose={() => {}}
        />
      );
    }
    return this.props.children;
  }
}
