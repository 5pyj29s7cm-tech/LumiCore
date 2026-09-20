import { lazy, StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { AppProvider } from '../contexts/AppContext';
import { ErrorBoundary } from '../components/ErrorBoundary';

const DesktopApp = lazy(() => import('./desktop').then(module => ({ default: module.DesktopApp })));

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <Suspense fallback={null}>
        <AppProvider><DesktopApp /></AppProvider>
      </Suspense>
    </ErrorBoundary>
  </StrictMode>,
);
