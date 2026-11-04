/** One-shot navigation identity; never shared between project sessions. */
export interface ReferenceNavigationRequest {
  id: number;
  projectSessionId: string;
  tableUuid: string;
  recordUuid: string;
}
