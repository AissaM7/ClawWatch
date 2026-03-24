// ── Hallucination Detection — pure TypeScript, deterministic ─────

import type {
  ClawEvent, Claim, HallucinationConfidence,
  HallucinationReport
} from './types';

// ── Completion language patterns ─────────────────────────────────

const COMPLETION_PHRASES = [
  'i have saved', 'i have written', 'i have fetched', 'i have downloaded',
  'i have created', 'i have deleted', 'i have sent', 'i have stored',
  'i have completed', 'i finished', 'the file has been', 'the data has been',
  'successfully saved', 'successfully fetched', 'successfully created',
  'successfully completed', 'task is complete', 'task is done',
  "i've saved", "i've written", "i've fetched", "i've created",
  'successfully downloaded', 'successfully sent', 'successfully stored',
  'i have scraped', "i've scraped", 'successfully scraped',
];

// ── Step 1: Extract completion claims ────────────────────────────

function extractSentence(text: string, phraseIndex: number): string {
  // Find sentence boundaries around the phrase
  let start = text.lastIndexOf('.', phraseIndex);
  if (start === -1) start = 0; else start += 1;

  let end = text.indexOf('.', phraseIndex + 1);
  if (end === -1) end = text.length; else end += 1;

  return text.substring(start, end).trim();
}

function extractObject(sentence: string): string {
  // Try to extract file paths
  const pathMatch = sentence.match(/[\/~][\w.\-\/]+\.\w+/);
  if (pathMatch) return pathMatch[0];

  // Try to extract URLs
  const urlMatch = sentence.match(/https?:\/\/[^\s,)]+/);
  if (urlMatch) return urlMatch[0];

  // Try to extract quoted strings
  const quoteMatch = sentence.match(/"([^"]+)"|'([^']+)'/);
  if (quoteMatch) return quoteMatch[1] || quoteMatch[2];

  // Try to extract numbers with context (e.g., "742 records")
  const numMatch = sentence.match(/(\d+)\s+(records?|events?|files?|items?|rows?|entries?)/i);
  if (numMatch) return numMatch[0];

  return '';
}

export function extractCompletionClaims(text: string): Claim[] {
  if (!text) return [];

  const textLower = text.toLowerCase();
  const claims: Claim[] = [];
  const seenSentences = new Set<string>();

  for (const phrase of COMPLETION_PHRASES) {
    let idx = textLower.indexOf(phrase);
    while (idx !== -1) {
      const sentence = extractSentence(text, idx);
      if (!seenSentences.has(sentence)) {
        seenSentences.add(sentence);
        claims.push({
          phrase,
          sentence,
          extracted_object: extractObject(sentence),
          verdict: 'unsupported', // default until checked
          explanation: '',
          confidence: 'low',
        });
      }
      idx = textLower.indexOf(phrase, idx + 1);
    }
  }

  return claims;
}

// ── Step 2: Build evidence map ───────────────────────────────────

interface EvidenceEntry {
  event_id: string;
  event_type: string;
  identifier: string;
  has_error: boolean;
  error_after?: boolean;
  tokens: string[];
  result_tokens: string[];
}

export interface EvidenceMap {
  entries: EvidenceEntry[];
}

function tokenizeForMatch(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s./\-_]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length >= 3);
}

export function buildEvidenceMap(events: ClawEvent[]): EvidenceMap {
  const entries: EvidenceEntry[] = [];
  const errorCallIds = new Set<string>();

  // First pass: collect error call IDs
  for (const e of events) {
    if (e.event_type === 'tool_error' && e.call_id) {
      errorCallIds.add(e.call_id);
    }
  }

  for (const event of events) {
    let identifier = '';
    let hasError = false;

    switch (event.event_type) {
      case 'tool_call_end':
        identifier = event.tool_name || '';
        hasError = event.call_id ? errorCallIds.has(event.call_id) : false;
        break;
      case 'file_write':
      case 'file_delete':
        identifier = event.file_path || '';
        break;
      case 'network_response':
        identifier = event.url || '';
        hasError = (event.response_status || 200) >= 400;
        break;
      case 'subprocess_exec':
        try {
          identifier = JSON.parse(event.command_tokens || '[]').join(' ');
        } catch {
          identifier = event.command_tokens || '';
        }
        hasError = (event.exit_code || 0) !== 0;
        break;
      case 'tool_error':
        identifier = event.tool_name || '';
        hasError = true;
        break;
      default:
        continue;
    }

    const allText = [
      identifier,
      event.tool_args || '',
      event.tool_result || '',
      event.file_path || '',
      event.url || '',
    ].join(' ');

    entries.push({
      event_id: event.event_id,
      event_type: event.event_type,
      identifier,
      has_error: hasError,
      tokens: tokenizeForMatch(identifier),
      result_tokens: tokenizeForMatch(allText),
    });
  }

  return { entries };
}

// ── Step 3: Match claims against evidence ────────────────────────

function computeOverlap(claimTokens: string[], evidenceTokens: string[]): number {
  if (claimTokens.length === 0) return 0;
  let matches = 0;
  for (const ct of claimTokens) {
    if (evidenceTokens.some(et => et.includes(ct) || ct.includes(et))) {
      matches++;
    }
  }
  return matches / claimTokens.length;
}

export function matchClaimToEvidence(claim: Claim, evidenceMap: EvidenceMap): Claim {
  const objectTokens = tokenizeForMatch(claim.extracted_object);
  const sentenceTokens = tokenizeForMatch(claim.sentence);
  const searchTokens = objectTokens.length > 0 ? objectTokens : sentenceTokens;

  let bestMatch: EvidenceEntry | null = null;
  let bestOverlap = 0;

  for (const entry of evidenceMap.entries) {
    const overlap = Math.max(
      computeOverlap(searchTokens, entry.result_tokens),
      computeOverlap(searchTokens, entry.tokens)
    );

    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      bestMatch = entry;
    }
  }

  const MATCH_THRESHOLD = 0.3;

  if (bestMatch && bestOverlap >= MATCH_THRESHOLD) {
    if (bestMatch.has_error) {
      // Contradicted — action exists but errored
      return {
        ...claim,
        verdict: 'contradicted',
        evidence_event_id: bestMatch.event_id,
        explanation: `Action found but resulted in error. Event type: ${bestMatch.event_type}, identifier: ${bestMatch.identifier}`,
        confidence: objectTokens.length > 0 ? 'high' : 'medium',
      };
    } else {
      // Supported — matching action found
      return {
        ...claim,
        verdict: 'supported',
        evidence_event_id: bestMatch.event_id,
        explanation: `Matching action found: ${bestMatch.event_type} on ${bestMatch.identifier}`,
        confidence: 'low',
      };
    }
  }

  // Unsupported — no matching action
  const confidence: HallucinationConfidence =
    objectTokens.length > 0 ? 'high' :
    sentenceTokens.length > 3 ? 'medium' : 'low';

  return {
    ...claim,
    verdict: 'unsupported',
    explanation: claim.extracted_object
      ? `No matching action for "${claim.extracted_object}" found in the event log.`
      : `Completion language detected but no specific action could be verified.`,
    confidence,
  };
}

// ── Step 4: Build hallucination report ───────────────────────────

export function buildHallucinationReport(
  events: ClawEvent[],
  llmEvent: ClawEvent
): HallucinationReport {
  const text = llmEvent.llm_output_full || llmEvent.prompt_preview || '';
  const claims = extractCompletionClaims(text);

  if (claims.length === 0) {
    return {
      has_hallucination: false,
      confidence: 'low',
      claims: [],
      unsupported_count: 0,
      contradicted_count: 0,
      llm_event_id: llmEvent.event_id,
      checked_at_offset_ms: llmEvent.run_offset_ms,
    };
  }

  const evidenceMap = buildEvidenceMap(
    events.filter(e => e.sequence_num <= llmEvent.sequence_num)
  );

  const evaluatedClaims = claims.map(c => matchClaimToEvidence(c, evidenceMap));

  const unsupported = evaluatedClaims.filter(c => c.verdict === 'unsupported').length;
  const contradicted = evaluatedClaims.filter(c => c.verdict === 'contradicted').length;
  const hasHallucination = unsupported > 0 || contradicted > 0;

  let overallConfidence: HallucinationConfidence = 'low';
  if (evaluatedClaims.some(c => c.confidence === 'high' && c.verdict !== 'supported')) {
    overallConfidence = 'high';
  } else if (evaluatedClaims.some(c => c.confidence === 'medium' && c.verdict !== 'supported')) {
    overallConfidence = 'medium';
  }

  return {
    has_hallucination: hasHallucination,
    confidence: overallConfidence,
    claims: evaluatedClaims,
    unsupported_count: unsupported,
    contradicted_count: contradicted,
    llm_event_id: llmEvent.event_id,
    checked_at_offset_ms: llmEvent.run_offset_ms,
  };
}

export function hasCompletionLanguage(text: string): boolean {
  if (!text) return false;
  const lower = text.toLowerCase();
  return COMPLETION_PHRASES.some(p => lower.includes(p));
}
