import { Injectable } from '@nestjs/common';
import { aboutServer, escapeHtml, renderEvent } from '../telegram/format';
import { TelegramStateStore } from '../telegram/state.store';
import { Answer } from './answer';
import { addressable, digestEvent, summarise } from './digest';
import { JobChoice } from './job-choices';
import { JobReports } from './job-reports';
import { ReportChoices, RepositoryReports } from './repository-reports';
import { ServerEstate, ServerEstates, workingOn } from './server-estates';

/** The Selected server's jobs, for the job menu. */
export interface JobChoices {
  /** The server's name. */
  server: string;
  /** Undefined when they could not be read; `unavailable` says why, in HTML. */
  jobs?: JobChoice[];
  unavailable?: string;
}

/**
 * What a command or a Button asks about the estate, answered.
 *
 * Which server a question is about is decided here, once: the server its
 * Button named, else the Selected server. A typed command names none, and
 * neither does a Button from before there was a list. With several servers
 * an answer says first which one it is about; every answer carries the
 * server's key for the Buttons under it.
 *
 * Apart from the cycle on purpose. These used to be members of the monitor,
 * each the same pass-through to a server's estate, so every new command added
 * one to the monitor's interface, to the class behind it and to the monitor
 * the tests stand in for it, and a test of one command built a whole monitor.
 * Nothing here watches anything or keeps anything: it reads which server is
 * selected, and asks that server's estate.
 *
 * Its methods are the questions and nothing else — what they share is
 * written beside the class — so the idle answers the tests use are held to
 * exactly these.
 */
@Injectable()
export class EstateAnswers {
  /** Whether an answer says which server it is about: only when there are several. */
  private readonly named: boolean;

  constructor(
    private readonly estates: ServerEstates,
    private readonly store: TelegramStateStore,
    private readonly reports: RepositoryReports,
    private readonly jobReports: JobReports,
  ) {
    this.named = estates.all.length > 1;
  }

  /**
   * Where every job of the Selected server stands, as a message somebody can
   * be handed.
   *
   * The same counting as the daily digest, pulled instead of pushed. It is
   * rendered here rather than emitted as an event on purpose: an event goes
   * through the router to the topic its severity implies, and a clean summary
   * asked for in General would land in the recoveries topic, where nobody who
   * asked for it is looking. An answer belongs where the question was.
   */
  async summary(): Promise<Answer> {
    const estate = asked(this.estates, this.store);
    const read = await estate.jobs.jobsNow();
    if (!read.ok) return about(estate, { text: read.message }, this.named);
    const working = await workingOn(estate);
    const summary = summarise(read.jobs, working.byJob, working.unavailable);
    const event = digestEvent(summary);
    return {
      // The very same event the daily message sends, rendered instead of
      // routed, and titled as the daily one is. Two renderings of one set of
      // figures began to differ within a day of existing; there is now
      // nothing that can differ.
      text: renderEvent(this.named ? aboutServer(event, estate.name) : event),
      // The jobs that are not well are exactly the ones somebody reading this
      // is about to ask about, so the summary offers them rather than making
      // them be typed back in.
      jobs: addressable(summary),
      server: estate.key,
    };
  }

  /** A Job card on the Selected server for a half-remembered name, or the choices when several match. */
  async describeJob(query: string): Promise<Answer> {
    const estate = asked(this.estates, this.store);
    return about(estate, await estate.jobs.describeJob(query), this.named);
  }

  /**
   * A Job card for a job a Button addressed by id, on the server the Button
   * named — or the Selected one, for a Button from before there was a list.
   */
  async describeJobById(id: string, server?: string): Promise<Answer> {
    const estate = asked(this.estates, this.store, server);
    return about(estate, await estate.jobs.describeJobById(id), this.named);
  }

  /** Every job on the Selected server, worst first, for the job menu. */
  async jobChoices(): Promise<JobChoices> {
    const estate = asked(this.estates, this.store);
    const read = await estate.jobs.choices();
    return read.ok ? { server: estate.name, jobs: read.jobs } : { server: estate.name, unavailable: read.message };
  }

  /** A job's restore points on the Selected server, named as for `describeJob`. */
  async describePoints(query: string): Promise<Answer> {
    const estate = asked(this.estates, this.store);
    return about(estate, await estate.jobs.describePoints(query), this.named);
  }

  /** A job's restore points for a Button that addressed it, as for `describeJobById`. */
  async describePointsById(id: string, server?: string): Promise<Answer> {
    const estate = asked(this.estates, this.store, server);
    return about(estate, await estate.jobs.describePointsById(id), this.named);
  }

  /**
   * One job's report over a month, asked for by a Button that addressed the
   * job by id on the server it named — or the Selected one: said at once to
   * be coming, and the PDF `later`.
   */
  jobReport(id: string, server?: string): Answer {
    return this.jobReports.asked(asked(this.estates, this.store, server), id);
  }

  /**
   * The Repository report of every server, whichever is selected — a
   * repository is shared by several — asked for: every repository, or the
   * ones `query` names. What is said at once — that it is coming and how long
   * it takes, or, for a name that matches none, the names there are — and the
   * PDF `later`, when one follows. Read on demand and kept for half an hour.
   */
  repositoryReport(query: string): Answer {
    return this.reports.asked(query);
  }

  /** The repositories the report can be asked for, in its order, as the cycles last saw them, and how long it takes. */
  repositoryChoices(): ReportChoices {
    return this.reports.choices();
  }
}

/** The server a question is about: the one its Button named, else the Selected server. */
const asked = (estates: ServerEstates, store: TelegramStateStore, server?: string): ServerEstate =>
  estates.all.find(({ key }) => key === server) ?? estates.selected(store.selectedServer());

/** An answer about `estate`, carrying its key for the Buttons under it, and naming it when there are several. */
const about = (estate: ServerEstate, answer: Answer, named: boolean): Answer =>
  named
    ? { ...answer, text: `🖥 <b>${escapeHtml(estate.name)}</b>\n\n${answer.text}`, server: estate.key }
    : { ...answer, server: estate.key };
