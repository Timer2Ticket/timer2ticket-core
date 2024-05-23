import { TimeEntry } from './time_entry';

export class RedmineTimeEntry implements TimeEntry {
  id: number;
  projectId: number;
  text: string;
  start: Date;
  end: Date;
  durationInMilliseconds: number;
  issueId: number | undefined;
  activityId: number;
  lastUpdated: Date;
  originalEntry: any;
  needsConfigJob: boolean;

  constructor(id: number, projectId: number, text: string, start: Date, end: Date,
    duration: number, issueId: number | undefined, activityId: number, lastUpdated: Date, originalEntry: any, needsConfigJob: boolean = false) {
    this.id = id;
    this.projectId = projectId;
    this.text = text;
    this.start = start;
    this.end = end;
    this.durationInMilliseconds = duration;
    this.issueId = issueId;
    this.activityId = activityId;
    this.lastUpdated = lastUpdated;
    this.originalEntry = originalEntry;
    this.needsConfigJob = needsConfigJob;
  }

  // durationInMilliseconds = (): number => this.end.getTime() - this.start.getTime();
}
