import { TimeEntry } from './time_entry';

export class TogglTimeEntry implements TimeEntry {
  id: number;
  projectId: number;
  text: string;
  start: Date;
  end: Date;
  durationInMilliseconds: number;
  tags: string[];
  lastUpdated: Date;
  originalEntry: any;
  needsConfigJob: boolean

  constructor(id: number, projectId: number, text: string, start: Date, end: Date, duration: number, tags: string[], lastUpdated: Date, originalEntry: any, needsConfigJob = false) {
    this.id = id;
    this.projectId = projectId;
    this.text = text;
    this.start = start;
    this.end = end;
    this.durationInMilliseconds = duration;
    this.tags = tags;
    this.lastUpdated = lastUpdated;
    this.originalEntry = originalEntry;
    this.needsConfigJob = needsConfigJob;
  }

  // durationInMilliseconds = (): number => this.end.getTime() - this.start.getTime();
}