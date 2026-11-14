import { describe, it, expect } from 'vitest';
import {
  brokerFormFromConfig,
  brokerFormToConfig,
  emptyBrokerForm,
  emptyBrokerTarget,
} from './meshcoreBrokerForm';

const KEY = 'ab'.repeat(32);

describe('meshcoreBrokerForm', () => {
  it('starts with the v1 defaults and refuses a form with no login method', () => {
    const f = emptyBrokerForm();
    expect([f.port, f.maxClients, f.maxMessagesPerSecond, f.maxPayloadKb]).toEqual(['1884', '50', '20', '64']);
    const r = brokerFormToConfig(f);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errorKey).toBe('source.form.mcb_error_no_auth');
  });

  it('builds a config with upper-cased keys, regions and limits in bytes', () => {
    const f = { ...emptyBrokerForm(), tokenAudience: 'aud', allowedObservers: `${KEY}\n`, regions: 'sea, pdx' };
    const r = brokerFormToConfig(f);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.config).toEqual({
      listener: { port: 1884 },
      auth: { tokenAudience: 'aud', allowedObservers: [KEY.toUpperCase()] },
      limits: { maxClients: 50, maxMessagesPerSecond: 20, maxPayloadBytes: 65536 },
      regions: ['SEA', 'PDX'],
      autoConnect: true,
    });
  });

  it('keeps a stored static password when the field is blank', () => {
    const f = { ...emptyBrokerForm(), username: 'local' };
    expect(brokerFormToConfig(f).ok).toBe(false);
    const r = brokerFormToConfig(f, true);
    expect(r.ok && (r.config.auth as Record<string, unknown>).password).toBe(undefined);
    expect(r.ok).toBe(true);
  });

  it('round-trips forwarding targets without seeding passwords back', () => {
    const target = {
      ...emptyBrokerTarget(),
      id: 't1',
      enabled: true,
      url: 'mqtt://up:1883',
      identityMode: 'own' as const,
      tokenAudience: 'up',
      observers: KEY,
      iataFilter: 'sea',
    };
    const r = brokerFormToConfig({ ...emptyBrokerForm(), tokenAudience: 'aud', targets: [target] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const back = brokerFormFromConfig({ ...r.config, auth: { ...(r.config.auth as object), password: 'stored' } });
    expect(back.password).toBe('');
    expect(back.targets[0]).toMatchObject({ id: 't1', identityMode: 'own', iataFilter: 'SEA', enabled: true });
  });

  it('needs a token audience on an enabled own-identity target', () => {
    const target = { ...emptyBrokerTarget(), enabled: true, url: 'mqtt://up', identityMode: 'own' as const };
    const r = brokerFormToConfig({ ...emptyBrokerForm(), tokenAudience: 'aud', targets: [target] });
    expect(r.ok).toBe(false);
  });
});
