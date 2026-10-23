// Copy shared by the answer card (TurnAnswer) and the PDF export.
export const GROUNDED_TEXT = 'Grounded in your documents.'
export const UNGROUNDED_TEXT =
  'This answer may not be fully grounded in the source document — verify against the sources below.'
// A grounded answer is never stored (Gemini terms — SECURITY_REVIEW.md §1.1); after a
// reload only this placeholder is left.
export const NOT_RETAINED_TEXT = 'Web-grounded answer, not retained (Google terms)'
