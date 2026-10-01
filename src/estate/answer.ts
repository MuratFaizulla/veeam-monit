/** A reply to a chat question, with the jobs its buttons may open next. */
export interface Answer {
  text: string;
  jobs?: Array<{ id: string; name: string }>;
  jobId?: string;
  /**
   * What a Button for one of these jobs opens: its card, or its restore
   * points. A /points answer that offered cards would send whoever pressed it
   * somewhere else than they asked to go.
   */
  about?: 'card' | 'points';
  /**
   * The key of the Veeam server the jobs are on. A job's Button carries it, so
   * that pressing it after somebody selected another server still opens the
   * job it was labelled with.
   */
  server?: string;
}
