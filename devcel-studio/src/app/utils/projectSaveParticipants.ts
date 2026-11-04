/** Explicit saves flush active inline drafts before saving the project snapshot. */
type Participant = { session: string; flush: () => Promise<boolean> };
const participants = new Set<Participant>();
export function registerProjectSaveParticipant(session: string, flush: () => Promise<boolean>) {
  const participant = { session, flush };
  participants.add(participant);
  return () => { participants.delete(participant); };
}
export async function flushProjectSaveParticipants(session: string): Promise<boolean> {
  // Snapshot before awaiting: newly mounted editors belong to a later save request.
  const captured = Array.from(participants);
  for (const participant of captured) {
    if (participant.session === session && participants.has(participant) && !await participant.flush()) return false;
  }
  return true;
}
