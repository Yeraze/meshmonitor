export type AdminOperationStatus =
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'timed_out'
  | 'rejected';

export type AdminOperationPhase =
  | 'queued'
  | 'acquiring_passkey'
  | 'sending'
  | 'awaiting_ack'
  | 'complete';

export interface AdminCommandAck {
  acked: boolean;
  timedOut: boolean;
  errorReason: number | null;
  status: string;
}

export interface AdminCommandResult {
  message: string;
  ack?: AdminCommandAck;
}

export interface AdminOperationError {
  code: string;
  message: string;
}

export interface AdminOperation {
  id: string;
  sourceId: string;
  destinationNodeNum: number;
  command: string;
  status: AdminOperationStatus;
  phase: AdminOperationPhase;
  createdAt: number;
  updatedAt: number;
  result?: AdminCommandResult;
  error?: AdminOperationError;
}

export interface AdminOperationAcceptedResponse {
  success: true;
  operation: AdminOperation;
}

export interface AdminOperationStatusResponse {
  success: true;
  operation: AdminOperation;
}

export interface AdminCommandSuccessResponse extends AdminCommandResult {
  success: true;
}

export type AdminCommandResponse = AdminCommandSuccessResponse | AdminOperationAcceptedResponse;
