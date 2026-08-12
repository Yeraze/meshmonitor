import type { AutomationTemplate } from './types';
import { autoAckTemplate } from './autoAck';
import { bridgeTemplate } from './bridge';

/** Registry of installable automation templates. Populated per template file. */
export const TEMPLATES: AutomationTemplate[] = [autoAckTemplate, bridgeTemplate];
