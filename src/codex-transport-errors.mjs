// Text classification only. Callers must first establish that this is a failure
// event from the intended transport, not tool output or a successful message.
const connectionFailure = /\b(?:(?:failed|unable)\s+to\s+(?:connect|establish\s+(?:a\s+)?(?:websocket\s+)?connection)|(?:cannot|could\s+not)\s+connect|(?:websocket\s+)?connection(?:\s+(?:attempt|setup|establishment))?\s+(?:failed|failure|refused)|connect(?:ion)?\s+error|ECONNREFUSED|ENETUNREACH|EHOSTUNREACH)\b/i;

export function isConnectionFailure(text) {
  return connectionFailure.test(String(text));
}
