import { NavLink } from "react-router-dom";

export function NavBar({ connected }: { connected: boolean }) {
  return (
    <nav className="navbar">
      <span className="navbar-brand">iptv-recorder</span>
      {connected && (
        <div className="navbar-links">
          <NavLink to="/providers">Providers</NavLink>
          <NavLink to="/recordings">Recordings</NavLink>
          <NavLink to="/recurring-rules">Recurring Rules</NavLink>
          <NavLink to="/config">Config</NavLink>
        </div>
      )}
      <NavLink to="/settings" className="navbar-settings">
        {connected ? "Settings" : "Connect"}
      </NavLink>
    </nav>
  );
}
