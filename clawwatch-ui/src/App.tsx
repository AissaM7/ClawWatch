import { BrowserRouter, Routes, Route, NavLink, useMatch, useLocation } from 'react-router-dom';
import RunList from './pages/RunList';
import RunDetail from './pages/RunDetail';
import RiskReview from './pages/RiskReview';
import CostDashboard from './pages/CostDashboard';
import './index.css';

function AppNav() {
  const location = useLocation();
  const m1 = useMatch('/run/:runId');
  const m2 = useMatch('/run/:runId/review');
  const m3 = useMatch('/run/:runId/cost');
  const runMatch = m1 || m2 || m3;
  const runId = runMatch?.params?.runId;

  return (
    <nav className="app-nav">
      <NavLink to="/" className="logo" style={{ textDecoration: 'none' }}>
        Claw<span>Watch</span>
      </NavLink>
      <div className="app-nav-links">
        <NavLink
          to="/"
          className={({ isActive }) => isActive && location.pathname === '/' ? 'active' : ''}
        >
          Runs
        </NavLink>
        {runId && (
          <>
            <NavLink
              to={`/run/${runId}`}
              end
              className={({ isActive }) => isActive ? 'active' : ''}
            >
              Timeline
            </NavLink>
            <NavLink
              to={`/run/${runId}/review`}
              className={({ isActive }) => isActive ? 'active' : ''}
            >
              Risk Review
            </NavLink>
            <NavLink
              to={`/run/${runId}/cost`}
              className={({ isActive }) => isActive ? 'active' : ''}
            >
              Cost
            </NavLink>
          </>
        )}
      </div>
    </nav>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <div className="app-layout">
        <AppNav />
        <div className="app-content">
          <Routes>
            <Route path="/" element={<RunList />} />
            <Route path="/run/:runId" element={<RunDetail />} />
            <Route path="/run/:runId/review" element={<RiskReview />} />
            <Route path="/run/:runId/cost" element={<CostDashboard />} />
          </Routes>
        </div>
      </div>
    </BrowserRouter>
  );
}
