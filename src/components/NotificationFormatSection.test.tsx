/**
 * @vitest-environment jsdom
 *
 * Message-notification format editor (#5593): the live preview is rendered by
 * the same function the server uses, an empty field means the default, and an
 * unknown token is flagged before the user saves.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { useState } from 'react';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../test/mockI18n');
  return createReactI18nextMock((key: string) => {
    const samples: Record<string, string> = {
      'notifications.format_sample_source': 'Sample Source',
      'notifications.format_sample_channel': 'LongFast',
      'notifications.format_sample_sender': 'Alice Mobile',
      'notifications.format_sample_sender_short': 'ALC',
      'notifications.format_sample_text': 'Anyone on the summit today?',
      'notifications.format_sample_node': 'NodeName',
      'notifications.format_sample_text_long': 'z'.repeat(400),
    };
    return samples[key] ?? key;
  });
});

import NotificationFormatSection from './NotificationFormatSection';
import { MESSAGE_TEMPLATE_TOKENS } from '../utils/notificationTemplate';

type Templates = { messageTitleTemplate: string | null; messageBodyTemplate: string | null };

function Host({
  initial = { messageTitleTemplate: null, messageBodyTemplate: null },
  onChange,
  prefix = false,
  sourceName = 'Home Base',
}: {
  initial?: Templates;
  onChange?: (next: Templates) => void;
  prefix?: boolean;
  sourceName?: string | null;
}) {
  const [value, setValue] = useState<Templates>(initial);
  return (
    <NotificationFormatSection
      titleTemplate={value.messageTitleTemplate}
      bodyTemplate={value.messageBodyTemplate}
      sourceName={sourceName}
      prefixWithNodeName={prefix}
      onChange={(next) => {
        setValue(next);
        onChange?.(next);
      }}
    />
  );
}

const text = (testId: string) => screen.getByTestId(testId).textContent;
const titleInput = () => document.getElementById('notif-format-title') as HTMLInputElement;
const bodyInput = () => document.getElementById('notif-format-body') as HTMLTextAreaElement;

describe('NotificationFormatSection', () => {
  it('previews the default for a channel message and a DM, with the source once', () => {
    render(<Host />);
    expect(text('notification-format-preview-channel-title')).toBe('LongFast · Home Base');
    expect(text('notification-format-preview-channel-body')).toBe('Alice Mobile: Anyone on the summit today?');
    expect(text('notification-format-preview-dm-title')).toBe('Alice Mobile · Home Base');
    expect(text('notification-format-preview-dm-body')).toBe('Anyone on the summit today?');
    for (const kind of ['channel', 'dm']) {
      expect(screen.getByTestId(`notification-format-preview-${kind}`).textContent!.split('Home Base')).toHaveLength(2);
    }
  });

  it('shows the default templates as placeholders and starts with empty fields', () => {
    render(<Host />);
    expect(titleInput().value).toBe('');
    expect(titleInput().placeholder).toBe('{{ channelName }} · {{ sourceName }}');
    expect(bodyInput().placeholder).toBe('{{ senderName }}: {{ text }}');
  });

  it('updates the preview live as the templates are edited', () => {
    const onChange = vi.fn();
    render(<Host onChange={onChange} />);

    fireEvent.change(titleInput(), { target: { value: '{{ senderShortName }} in {{ channelName }}' } });
    fireEvent.change(bodyInput(), { target: { value: '{{ text }}' } });

    expect(text('notification-format-preview-channel-title')).toBe('ALC in LongFast');
    expect(text('notification-format-preview-channel-body')).toBe('Anyone on the summit today?');
    // The same pair for a DM: no channel.
    expect(text('notification-format-preview-dm-title')).toBe('ALC in');
    expect(onChange).toHaveBeenLastCalledWith({
      messageTitleTemplate: '{{ senderShortName }} in {{ channelName }}',
      messageBodyTemplate: '{{ text }}',
    });
  });

  it('clearing a field stores null (the default), never an empty string', () => {
    const onChange = vi.fn();
    render(<Host initial={{ messageTitleTemplate: 'X', messageBodyTemplate: 'Y' }} onChange={onChange} />);
    fireEvent.change(titleInput(), { target: { value: '   ' } });
    expect(onChange).toHaveBeenLastCalledWith({ messageTitleTemplate: null, messageBodyTemplate: 'Y' });
    expect(text('notification-format-preview-channel-title')).toBe('LongFast · Home Base');
  });

  it('lists every token, and clicking one adds it to the body', () => {
    const onChange = vi.fn();
    render(<Host onChange={onChange} />);
    for (const token of MESSAGE_TEMPLATE_TOKENS) {
      expect(screen.getByRole('button', { name: `{{ ${token} }}` })).toBeTruthy();
    }
    fireEvent.click(screen.getByRole('button', { name: '{{ senderShortName }}' }));
    expect(onChange).toHaveBeenLastCalledWith({ messageTitleTemplate: null, messageBodyTemplate: '{{ senderShortName }}' });
    expect(text('notification-format-preview-channel-body')).toBe('ALC');
  });

  it('flags an unknown token below the field', () => {
    render(<Host initial={{ messageTitleTemplate: '{{ source_name }}', messageBodyTemplate: null }} />);
    expect(screen.getByText(/is not a recognized token/)).toBeTruthy();
    expect(screen.getByText('{{ source_name }}', { selector: 'code' })).toBeTruthy();
  });

  it('does not flag an Automation Engine token as merely "foreign" — it is unknown here', () => {
    render(<Host initial={{ messageTitleTemplate: null, messageBodyTemplate: '{{ trigger.text }}' }} />);
    expect(screen.getByText(/is not a recognized token/)).toBeTruthy();
  });

  it('Reset to default clears both templates and is disabled when already default', () => {
    const onChange = vi.fn();
    render(<Host initial={{ messageTitleTemplate: 'X', messageBodyTemplate: 'Y' }} onChange={onChange} />);
    const reset = screen.getByRole('button', { name: /notifications\.format_reset/ }) as HTMLButtonElement;
    expect(reset.disabled).toBe(false);
    fireEvent.click(reset);
    expect(onChange).toHaveBeenLastCalledWith({ messageTitleTemplate: null, messageBodyTemplate: null });
    expect(reset.disabled).toBe(true);
  });

  it('shows the [node name] prefix in front of the previewed body when that option is on', () => {
    render(<Host prefix initial={{ messageTitleTemplate: null, messageBodyTemplate: '{{ text }}' }} />);
    expect(text('notification-format-preview-channel-body')).toBe('[NodeName] Anyone on the summit today?');
    expect(text('notification-format-preview-channel-title')).toBe('LongFast · Home Base');
  });

  it('falls back to a sample source name outside a source view', () => {
    render(<Host sourceName={null} />);
    expect(text('notification-format-preview-channel-title')).toBe('LongFast · Sample Source');
  });

  it('renders template text as text — markup typed into a field is never interpreted', () => {
    render(<Host initial={{ messageTitleTemplate: null, messageBodyTemplate: '<img src=x onerror=alert(1)>{{ text }}' }} />);
    const preview = screen.getByTestId('notification-format-preview-channel-body');
    expect(preview.querySelector('img')).toBeNull();
    expect(preview.textContent).toBe('img src=x onerror=alert(1)Anyone on the summit today?');
  });
});

describe('NotificationFormatSection - message text length (#6278)', () => {
  type Max = { messageTextMaxPush: number | null; messageTextMaxApprise: number | null };

  function MaxHost({
    initial = { messageTextMaxPush: null, messageTextMaxApprise: null },
    onTextMaxChange,
    showApprise = true,
  }: {
    initial?: Max;
    onTextMaxChange?: (next: Max) => void;
    showApprise?: boolean;
  }) {
    const [value, setValue] = useState<Max>(initial);
    return (
      <NotificationFormatSection
        titleTemplate={null}
        bodyTemplate={'{{ text }}'}
        sourceName="Home Base"
        textMaxPush={value.messageTextMaxPush}
        textMaxApprise={value.messageTextMaxApprise}
        showApprise={showApprise}
        onChange={() => {}}
        onTextMaxChange={(next) => {
          setValue(next);
          onTextMaxChange?.(next);
        }}
      />
    );
  }

  const pushInput = () => document.getElementById('notif-text-max-push') as HTMLInputElement;
  const appriseInput = () => document.getElementById('notif-text-max-apprise') as HTMLInputElement;

  it('starts blank and previews the default length of 100', () => {
    render(<MaxHost />);
    expect(pushInput().value).toBe('');
    expect(pushInput().placeholder).toBe('100');
  });

  it('a blank value stores null', () => {
    const onTextMaxChange = vi.fn();
    render(<MaxHost initial={{ messageTextMaxPush: 250, messageTextMaxApprise: null }} onTextMaxChange={onTextMaxChange} />);
    fireEvent.change(pushInput(), { target: { value: '' } });
    expect(onTextMaxChange).toHaveBeenLastCalledWith({ messageTextMaxPush: null, messageTextMaxApprise: null });
  });

  it('never stores a value outside 20 to 1000', () => {
    const onTextMaxChange = vi.fn();
    render(<MaxHost onTextMaxChange={onTextMaxChange} />);
    fireEvent.change(pushInput(), { target: { value: '5000' } });
    fireEvent.change(pushInput(), { target: { value: '3' } });
    fireEvent.change(pushInput(), { target: { value: '12.5' } });
    expect(onTextMaxChange).not.toHaveBeenCalled();
    expect(pushInput().getAttribute('aria-invalid')).toBe('true');
    fireEvent.change(pushInput(), { target: { value: '1000' } });
    expect(onTextMaxChange).toHaveBeenLastCalledWith({ messageTextMaxPush: 1000, messageTextMaxApprise: null });
  });

  it('the preview reflects the push length', () => {
    render(<MaxHost initial={{ messageTextMaxPush: 250, messageTextMaxApprise: null }} />);
    expect(text('notification-format-preview-channel-body')).toBe(`${'z'.repeat(247)}...`);
    fireEvent.change(pushInput(), { target: { value: '60' } });
    expect(text('notification-format-preview-channel-body')).toBe(`${'z'.repeat(57)}...`);
  });

  it('the {{ text }} token help follows the configured length, not a fixed 100 (#4173 review L31)', () => {
    const tokenHelp = () =>
      Array.from(document.querySelectorAll('li')).find((li) => li.textContent?.includes('{{ text }}'))?.textContent ?? '';
    const { unmount } = render(<MaxHost initial={{ messageTextMaxPush: 250, messageTextMaxApprise: null }} showApprise={false} />);
    expect(tokenHelp()).toContain('notifications.format_token_text_n');
    expect(tokenHelp()).not.toContain('notifications.format_token_text_split');
    unmount();
    render(<MaxHost initial={{ messageTextMaxPush: 250, messageTextMaxApprise: 500 }} />);
    expect(tokenHelp()).toContain('notifications.format_token_text_split');
  });

  it('shows the Apprise input only when Apprise is on, and stores it separately', () => {
    const onTextMaxChange = vi.fn();
    const { unmount } = render(<MaxHost showApprise={false} />);
    expect(appriseInput()).toBeNull();
    unmount();
    render(<MaxHost onTextMaxChange={onTextMaxChange} />);
    fireEvent.change(appriseInput(), { target: { value: '500' } });
    expect(onTextMaxChange).toHaveBeenLastCalledWith({ messageTextMaxPush: null, messageTextMaxApprise: 500 });
  });
});

