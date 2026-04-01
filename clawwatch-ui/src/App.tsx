import { BrowserRouter, Routes, Route } from 'react-router-dom';
import Overview from './pages/Overview';
import AgentList from './pages/AgentList';
import AgentDashboard from './pages/AgentDashboard';
import ThreadDetail from './pages/ThreadDetail';
import RunList from './pages/RunList';
import RunDetail from './pages/RunDetail';
import RiskReview from './pages/RiskReview';
import CostDashboard from './pages/CostDashboard';
import GlobalUsage from './pages/GlobalUsage';
import Security from './pages/Security';
import Sidebar from './components/Sidebar';
import './index.css';

export default function App() {
  return (
    <BrowserRouter>
      <div className="app-layout">
        <Sidebar />
        <div className="app-content">
          <Routes>
            {/* Main */}
            <Route path="/" element={<Overview />} />
            <Route path="/runs" element={<RunList />} />
            <Route path="/agents" element={<AgentList />} />
            {/* Insights */}
            <Route path="/usage" element={<GlobalUsage />} />
            <Route path="/security" element={<Security />} />
            {/* Detail Views */}
            <Route path="/agent/:agentId" element={<AgentDashboard />} />
            <Route path="/thread/:threadId" element={<ThreadDetail />} />
            <Route path="/run/:runId" element={<RunDetail />} />
            <Route path="/run/:runId/review" element={<RiskReview />} />
            <Route path="/run/:runId/cost" element={<CostDashboard />} />
          </Routes>
        </div>
      </div>
    </BrowserRouter>
  );
}
