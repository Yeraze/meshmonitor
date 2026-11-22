/**
 * Readable text for the sender-name error codes the channel send route returns
 * (#6341 P4). Returns null for any other code so the caller keeps the server's
 * own message.
 */
import type { TFunction } from 'i18next';

export function senderNameErrorMessage(code: unknown, t: TFunction): string | null {
  switch (code) {
    case 'SENDER_NAME_DISABLED':
      return t('meshcore.sender_name.err_disabled', 'Sending under another name is off for this source.');
    case 'SENDER_NAME_NOT_ALLOWED':
      return t('meshcore.sender_name.err_not_allowed', 'That sender name is not on the allowed list for this source.');
    case 'CLIENT_REPEAT_ON':
      return t('meshcore.sender_name.err_client_repeat', 'This node has client repeat on, so it cannot send under another name. Send as the node name instead.');
    default:
      return null;
  }
}
