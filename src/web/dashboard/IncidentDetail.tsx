import { useState } from 'react';
import type { ReactElement } from 'react';
import type {
  AlertSummary,
  IncidentDetailResponse,
  MitigationProposalSummary,
  TransitionEvent,
} from './statusTypes.js';
import {
  evidenceList,
  evidenceText,
  semanticSummary,
  transitionType,
  verificationChecks,
} from './evidenceView.js';
import { deriveOperatorReadout, stageEvents } from './operatorReadout.js';
import type { OperatorReadout } from './operatorReadout.js';
import { formatAge } from './statusView.js';

function severityClass(value: string | null): string {
  return `severity severity-${(value ?? 'NONE').toLowerCase()}`;
}

function display(value: string | null | undefined): string {
  return value && value.trim() !== '' ? value : 'none';
}

function eventMetadata(event: TransitionEvent): string {
  return [
    transitionType(event),
    evidenceText(event, 'status'),
    evidenceText(event, 'classification'),
    evidenceText(event, 'disposition'),
  ]
    .filter(Boolean)
    .join(' · ');
}

function EvidenceBullets({ items }: { items: string[] }): ReactElement | null {
  if (items.length === 0) {
    return null;
  }
  return (
    <ul className="compact-list">
      {items.slice(0, 6).map((item) => (
        <li key={item}>{item}</li>
      ))}
    </ul>
  );
}

/**
 * Ranked root-cause hypotheses with their confidence scores. The Investigate stage has always
 * produced these; until now the page dropped them, which is why an incident whose cause was
 * identified at 0.86 confidence still read as unexplained.
 */
function LikelyCauses({ readout }: { readout: OperatorReadout }): ReactElement | null {
  if (readout.likelyCauses.length === 0) {
    return null;
  }
  return (
    <ol className="cause-list">
      {readout.likelyCauses.slice(0, 3).map((cause) => (
        <li key={cause.cause}>
          <strong>{cause.cause}</strong>
          {cause.confidence === null ? null : (
            <span className="confidence">confidence {cause.confidence.toFixed(2)}</span>
          )}
        </li>
      ))}
    </ol>
  );
}

/** Copies the markdown handoff brief, falling back to opening it when the clipboard is blocked. */
function HandoffButton({ incidentId }: { incidentId: string }): ReactElement {
  const [label, setLabel] = useState('Copy handoff');
  const briefUrl = `/api/incidents/${encodeURIComponent(incidentId)}/brief`;

  const copy = (): void => {
    void fetch(briefUrl)
      .then(async (response) => await response.text())
      .then(async (markdown) => {
        await navigator.clipboard.writeText(markdown);
        setLabel('Copied');
      })
      .catch(() => {
        window.open(briefUrl, '_blank');
      });
  };

  return (
    <div className="handoff">
      <button type="button" onClick={copy}>
        {label}
      </button>
      <a href={briefUrl}>view brief</a>
    </div>
  );
}

function OperatorReadoutPanel({
  incident,
  events,
}: {
  incident: IncidentDetailResponse['incident'];
  events: TransitionEvent[];
}): ReactElement {
  const readout = deriveOperatorReadout(incident, events);
  return (
    <section className={`operator-readout readout-${readout.tone}`}>
      <div className="readout-lede">
        <p className="eyebrow">Operator Readout</p>
        <h2>{readout.headline}</h2>
        <p>{readout.why}</p>
        <p className="readout-meta">Last activity {formatAge(readout.lastActivityAt)}</p>
        <HandoffButton incidentId={incident.incidentId} />
      </div>
      <div className="readout-grid">
        <div>
          <span>Likely Causes</span>
          {readout.likelyCauses.length === 0 ? (
            <p>No root-cause hypothesis was recorded.</p>
          ) : (
            <LikelyCauses readout={readout} />
          )}
        </div>
        <div>
          <span>Closure Gate</span>
          <p>{readout.closeGate}</p>
        </div>
        <div>
          <span>Next Checks</span>
          <EvidenceBullets items={readout.nextActions} />
        </div>
        <div>
          <span>Open Evidence Gaps</span>
          {readout.evidenceRequirements.length === 0 ? (
            <p>No outstanding evidence requirements.</p>
          ) : (
            <ul className="compact-list">
              {readout.evidenceRequirements.slice(0, 4).map((requirement) => (
                <li key={requirement.description}>
                  {requirement.description}
                  {requirement.toolHint ? (
                    <span className="tool-hint">Run: {requirement.toolHint}</span>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </div>
        <div>
          <span>Latest Evidence</span>
          <EvidenceBullets items={readout.evidence} />
        </div>
      </div>
    </section>
  );
}

/**
 * The current mitigation *proposal*. It leads with a plain statement that nothing was executed,
 * because the whole point of the stage is that a human decides — the panel is a decision aid, not
 * a report that something happened.
 */
function MitigationProposalPanel({
  proposals,
}: {
  proposals: MitigationProposalSummary[];
}): ReactElement | null {
  const current = proposals.find((row) => row.outcome === 'proposed' && row.proposal);
  const proposal = current?.proposal;
  if (!proposal) {
    return null;
  }

  const confidence =
    proposal.cause_confidence === null
      ? proposal.proposal_confidence
      : `${proposal.proposal_confidence} · cause ${proposal.cause_confidence.toFixed(2)}`;

  return (
    <section className={`operator-readout readout-${proposal.action_kind === 'no_action' ? 'stale' : 'red'}`}>
      <div className="readout-lede">
        <p className="eyebrow">Proposed Mitigation · needs human approval</p>
        <h2>{proposal.action}</h2>
        <p>
          Nothing has been executed — this agent cannot make changes. Review and act out of band.
        </p>
        <p className="readout-meta">
          {proposal.action_kind} · {proposal.reversibility} to reverse · confidence {confidence}
        </p>
      </div>
      <div className="readout-grid">
        <div>
          <span>Target</span>
          <p>
            {proposal.target.kind}: <code>{proposal.target.identifier}</code>
          </p>
        </div>
        <div>
          <span>Addresses</span>
          <p>{proposal.addresses_cause}</p>
        </div>
        <div>
          <span>Blast Radius</span>
          <p>{proposal.blast_radius}</p>
        </div>
        <div>
          <span>Check First</span>
          {proposal.preconditions.length === 0 ? (
            <p>No preconditions recorded.</p>
          ) : (
            <EvidenceBullets items={proposal.preconditions} />
          )}
        </div>
        <div>
          <span>Rollback</span>
          {proposal.rollback_plan.length === 0 ? (
            <p>No rollback recorded.</p>
          ) : (
            <EvidenceBullets items={proposal.rollback_plan} />
          )}
        </div>
        <div>
          <span>Success Signal</span>
          <p>{proposal.success_signal.description}</p>
        </div>
      </div>
    </section>
  );
}

function StagePanel({
  title,
  events,
}: {
  title: string;
  events: TransitionEvent[];
}): ReactElement {
  return (
    <section className="panel">
      <div className="panel-title">
        <h2>{title}</h2>
        <span>{events.length}</span>
      </div>
      {events.length === 0 ? (
        <p className="empty">No {title.toLowerCase()} events.</p>
      ) : (
        <ol className="timeline">
          {events.map((event) => (
            <li key={event.id}>
              <div>
                <strong>{event.message}</strong>
                <small>
                  {event.stage} · {formatAge(event.createdAt)} ·{' '}
                  {eventMetadata(event) || 'event'}
                </small>
                <EvidenceBullets
                  items={[
                    ...evidenceList(event, 'evidence'),
                    ...evidenceList(event, 'supporting_evidence'),
                    ...evidenceList(event, 'confirmed_facts'),
                    ...semanticSummary(event),
                  ]}
                />
                {verificationChecks(event).length > 0 ? (
                  <ul className="compact-list">
                    {verificationChecks(event)
                      .slice(0, 4)
                      .map((check) => (
                        <li key={`${String(check['tool'])}:${String(check['target'])}`}>
                          {String(check['status'])}: {String(check['tool'])} {String(check['target'])}
                        </li>
                      ))}
                  </ul>
                ) : null}
              </div>
              <span className={severityClass(event.severity)}>{event.severity ?? 'NONE'}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function AlertHistory({ alerts }: { alerts: AlertSummary[] }): ReactElement {
  return (
    <section className="panel">
      <div className="panel-title">
        <h2>Alert History</h2>
        <span>{alerts.length}</span>
      </div>
      {alerts.length === 0 ? (
        <p className="empty">No alerts sent for this incident.</p>
      ) : (
        <ol className="timeline">
          {alerts.map((alert) => (
            <li key={alert.id}>
              <div>
                <strong>{alert.channel}</strong>
                <small>
                  {formatAge(alert.sentAt)} · {alert.dedupeKey}
                </small>
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

export function IncidentDetail({ data }: { data: IncidentDetailResponse }): ReactElement {
  const { incident, events, alerts } = data;
  const mitigationProposals = data.mitigationProposals ?? [];
  const readyForMitigation =
    incident.currentDisposition === 'MITIGATE' || incident.currentNextStage === 'Mitigate';

  return (
    <main className="shell">
      <header className={`status-band ${readyForMitigation ? 'tone-red' : 'tone-yellow'}`}>
        <div>
          <p className="eyebrow">Incident</p>
          <h1>{incident.title}</h1>
        </div>
        <p>
          {incident.incidentId} · {display(incident.service)} · {incident.state}
        </p>
      </header>

      <section className="metrics-grid" aria-label="incident summary">
        <div className="metric">
          <span>Severity</span>
          <strong>{incident.severity}</strong>
          <small>{incident.state}</small>
        </div>
        <div className="metric">
          <span>Disposition</span>
          <strong>{display(incident.currentDisposition)}</strong>
          <small>next {display(incident.currentNextStage)}</small>
        </div>
        <div className={readyForMitigation ? 'metric metric-stale' : 'metric'}>
          <span>Mitigation</span>
          <strong>{readyForMitigation ? 'Ready' : 'Not ready'}</strong>
          <small>opened {formatAge(incident.openedAt)}</small>
        </div>
        <div className="metric">
          <span>Source run</span>
          <strong>
            {incident.lastRunId ? (
              <a href={`/runs/${encodeURIComponent(incident.lastRunId)}`}>
                {incident.lastRunId}
              </a>
            ) : (
              display(incident.lastRunId)
            )}
          </strong>
          <small>closed {formatAge(incident.closedAt)}</small>
        </div>
      </section>

      <OperatorReadoutPanel incident={incident} events={events} />

      <MitigationProposalPanel proposals={mitigationProposals} />

      <section className="content-grid">
        <StagePanel title="Classification" events={stageEvents(events, 'Classify')} />
        <StagePanel title="Investigation" events={stageEvents(events, 'Investigate')} />
        <StagePanel title="Decision" events={stageEvents(events, 'Decide')} />
        <StagePanel title="Verification" events={stageEvents(events, 'Verify')} />
      </section>

      <section className="content-grid">
        <StagePanel title="Timeline" events={events} />
        <AlertHistory alerts={alerts} />
      </section>
    </main>
  );
}
