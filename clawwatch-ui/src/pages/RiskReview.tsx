import { useState, useEffect, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import type { ClawEvent, EnrichedEvent } from '../lib/types';
import { fetchRunEvents, submitReview } from '../lib/api';
import { scoreEvent } from '../lib/risk';
import { scoreGoalAlignment } from '../lib/goalAlignment';
import { buildDescription, formatOffset } from '../lib/descriptions';

function enrichEvents(events: ClawEvent[], goal: string): EnrichedEvent[] {
  return events.map(e => ({
    ...e,
    risk: scoreEvent(e, events),
    goal_alignment: scoreGoalAlignment(e, goal),
    description: buildDescription(e),
  }));
}

export default function RiskReview() {
  const { runId } = useParams<{ runId: string }>();
  const navigate = useNavigate();
  const [rawEvents, setRawEvents] = useState<ClawEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [reviewNotes, setReviewNotes] = useState<Record<string, string>>({});
  const [reviewedIds, setReviewedIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!runId) return;
    fetchRunEvents(runId)
      .then(events => {
        setRawEvents(events);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [runId]);

  const goal = rawEvents.length > 0 ? rawEvents[0].goal : '';
  const enriched = useMemo(() => enrichEvents(rawEvents, goal), [rawEvents, goal]);

  const reviewItems = useMemo(
    () => enriched
      .filter(e => e.risk.requires_review)
      .sort((a, b) => b.risk.score - a.risk.score),
    [enriched]
  );

  const handleReview = async (eventId: string) => {
    if (!runId) return;
    const note = reviewNotes[eventId] || '';
    await submitReview(runId, eventId, note);
    setReviewedIds(prev => new Set(prev).add(eventId));
  };

  if (loading) {
    return (
      <div className="waiting-state">
        <div className="waiting-icon" />
        <p>Loading events...</p>
      </div>
    );
  }

  return (
    <div>
      <div className="page-header">
        <button className="back-btn" onClick={() => navigate(`/run/${runId}`)}>
          ← Back to Run
        </button>
        <h1>Risk Review Queue</h1>
        <p>{reviewItems.length} event{reviewItems.length !== 1 ? 's' : ''} requiring review</p>
      </div>

      {reviewItems.length === 0 ? (
        <div className="empty-state">
          <h2>All clear</h2>
          <p>No events requiring review in this run.</p>
        </div>
      ) : (
        <div className="review-queue">
          {reviewItems.map(event => (
            <div key={event.event_id} className="review-item">
              <div className="review-item-header">
                <span className={`risk-badge ${event.risk.level}`}>{event.risk.level}</span>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-secondary)' }}>
                  {event.event_type}
                </span>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-tertiary)', marginLeft: 'auto' }}>
                  {formatOffset(event.run_offset_ms)}
                </span>
              </div>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 13, color: 'var(--text-primary)', marginBottom: 8 }}>
                {event.description}
              </div>
              {event.risk.rules.map((rule, i) => (
                <div key={i} className={`risk-rule-item ${rule.level}`} style={{ marginBottom: 4 }}>
                  <div className="rule-name">{rule.name}</div>
                  <div className="rule-explanation">{rule.explanation}</div>
                </div>
              ))}

              {reviewedIds.has(event.event_id) ? (
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--color-safe)', marginTop: 8 }}>
                  ✓ Reviewed
                </div>
              ) : (
                <>
                  <textarea
                    className="review-note-input"
                    placeholder="Add a review note..."
                    value={reviewNotes[event.event_id] || ''}
                    onChange={e => setReviewNotes(prev => ({ ...prev, [event.event_id]: e.target.value }))}
                  />
                  <button
                    className="review-submit-btn"
                    onClick={() => handleReview(event.event_id)}
                  >
                    Mark Reviewed
                  </button>
                </>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
