import type { ReactNode } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { NavBar } from "./components/NavBar";
import { useApiKey } from "./hooks/useApiKey";
import { Settings } from "./pages/Settings";
import { Providers } from "./pages/Providers";
import { Recordings } from "./pages/Recordings";
import { RecurringRules } from "./pages/RecurringRules";
import { Config } from "./pages/Config";

function RequireApiKey({ children }: { children: ReactNode }) {
  const { apiKey } = useApiKey();
  if (!apiKey) {
    return <Navigate to="/settings" replace />;
  }
  return <>{children}</>;
}

function App() {
  const { apiKey } = useApiKey();

  return (
    <BrowserRouter>
      <NavBar connected={!!apiKey} />
      <Routes>
        <Route path="/settings" element={<Settings />} />
        <Route
          path="/providers"
          element={
            <RequireApiKey>
              <Providers />
            </RequireApiKey>
          }
        />
        <Route
          path="/recordings"
          element={
            <RequireApiKey>
              <Recordings />
            </RequireApiKey>
          }
        />
        <Route
          path="/recurring-rules"
          element={
            <RequireApiKey>
              <RecurringRules />
            </RequireApiKey>
          }
        />
        <Route
          path="/config"
          element={
            <RequireApiKey>
              <Config />
            </RequireApiKey>
          }
        />
        <Route path="*" element={<Navigate to={apiKey ? "/providers" : "/settings"} replace />} />
      </Routes>
    </BrowserRouter>
  );
}

export default App;
