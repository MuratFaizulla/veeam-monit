/** A reply to a chat question, with the jobs its buttons may open next. */
export interface Answer {
  text: string;
  jobs?: Array<{ id: string; name: string }>;
  jobId?: string;
}
