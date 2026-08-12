import type { AutomationTemplate } from './types';
import { autoAckTemplate } from './autoAck';

/** Registry of installable automation templates. Populated per template file. */
export const TEMPLATES: AutomationTemplate[] = [autoAckTemplate];
