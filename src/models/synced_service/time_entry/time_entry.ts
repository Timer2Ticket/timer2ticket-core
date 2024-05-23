export interface TimeEntry {
  id: number | string;
  projectId: number | string;
  text: string;
  start: Date | number | string;
  end: Date | number | string;
  durationInMilliseconds: number;
  lastUpdated: Date | number | string;
  originalEntry: any;
  needsConfigJob: boolean;
}