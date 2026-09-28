/** A reply to a chat question, with the jobs its buttons may open next. */
export interface Answer {
  text: string;
  jobs?: Array<{ id: string; name: string }>;
  jobId?: string;
  /**
   * The key of the Veeam server the jobs are on. A job's Button carries it, so
   * that pressing it after somebody selected another server still opens the
   * job it was labelled with.
   */
  server?: string;
}
