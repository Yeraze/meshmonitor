import React from 'react';

/**
 * A single expansion token and a short description of what it resolves to.
 */
export interface AutomationTokenInfo {
  /** The literal placeholder, including braces — e.g. `{HOPS}`. */
  token: string;
  /** One-line human description of what the token expands to. */
  description: string;
}

/**
 * A named group of tokens that share an availability context (e.g. "works
 * everywhere" vs "only when replying to a received message").
 */
export interface AutomationTokenGroup {
  /** Heading for the group. */
  title: string;
  /** Optional clarifying sentence shown under the heading. */
  note?: string;
  tokens: AutomationTokenInfo[];
}

interface AutomationTokenReferenceProps {
  /** Box heading — e.g. "Available message tokens". */
  title: string;
  /** Optional intro sentence shown under the title. */
  intro?: string;
  groups: AutomationTokenGroup[];
  /**
   * Optional callout rendered below the token groups — e.g. a link
   * recommending the Automation Engine. Highlighted so it stands out.
   */
  footer?: React.ReactNode;
}

/**
 * Single source-of-truth reference block for the expansion tokens usable in
 * an Automations page. Rendered once near the top of the page so the token
 * list lives in exactly one place instead of being duplicated next to every
 * token-aware field. Tokens are grouped by availability context because some
 * (sender / signal / route fields) only resolve when responding to a received
 * message and are meaningless in scheduled messages.
 */
export const AutomationTokenReference: React.FC<AutomationTokenReferenceProps> = ({ title, intro, groups, footer }) => {
  return (
    <div
      className="automation-token-reference settings-section"
      style={{
        marginBottom: '1.5rem',
        padding: '1rem 1.25rem',
        background: 'var(--ctp-surface0)',
        border: '1px solid var(--ctp-surface1)',
        borderRadius: '8px',
      }}
    >
      <h3 style={{ margin: '0 0 0.25rem' }}>{title}</h3>
      {intro && (
        <p style={{ margin: '0 0 1rem', fontSize: '0.85rem', color: 'var(--ctp-subtext0)', lineHeight: 1.5 }}>
          {intro}
        </p>
      )}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '1.5rem' }}>
        {groups.map((group) => (
          <div key={group.title} style={{ flex: '1 1 260px', minWidth: '260px' }}>
            <div style={{ fontWeight: 'bold', fontSize: '0.85rem', marginBottom: '0.25rem' }}>{group.title}</div>
            {group.note && (
              <div style={{ fontSize: '0.75rem', color: 'var(--ctp-subtext0)', marginBottom: '0.5rem', lineHeight: 1.4 }}>
                {group.note}
              </div>
            )}
            <dl style={{ margin: 0, display: 'grid', gridTemplateColumns: 'max-content 1fr', columnGap: '0.5rem', rowGap: '0.2rem', fontSize: '0.8rem' }}>
              {group.tokens.map((tok) => (
                <React.Fragment key={tok.token}>
                  <dt>
                    <code style={{ fontFamily: 'monospace', color: 'var(--ctp-mauve)' }}>{tok.token}</code>
                  </dt>
                  <dd style={{ margin: 0, color: 'var(--ctp-subtext1)' }}>{tok.description}</dd>
                </React.Fragment>
              ))}
            </dl>
          </div>
        ))}
      </div>
      {footer && (
        <div
          style={{
            marginTop: '1rem',
            padding: '0.6rem 0.85rem',
            background: 'var(--ctp-surface1)',
            border: '1px solid var(--ctp-mauve)',
            borderRadius: '6px',
            fontSize: '0.85rem',
            lineHeight: 1.5,
          }}
        >
          {footer}
        </div>
      )}
    </div>
  );
};

export default AutomationTokenReference;
