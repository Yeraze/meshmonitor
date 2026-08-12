import type { FieldDef } from '../catalog';
import type { AutomationGraph } from '../../../types/automation';

/** A template parameter reuses the automation builder's field model. */
export type ParamSpec = FieldDef;

export interface BuiltAutomation {
  name: string;
  description: string;
  config: AutomationGraph;
}

export interface AutomationTemplate {
  id: string;
  name: string;
  description: string;
  icon: string;            // UiIcon name
  tags: string[];
  params: ParamSpec[];
  /** May return ONE automation or an ARRAY (a bridge template produces a pair). */
  build(values: Record<string, unknown>): BuiltAutomation | BuiltAutomation[];
}
