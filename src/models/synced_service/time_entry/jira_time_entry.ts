import { TimeEntry } from "./time_entry";

export class JiraTimeEntry implements TimeEntry {
    id: number | string;
    projectId: number | string;
    text: string;
    start: Date | number | string;
    end: Date | number | string;
    durationInMilliseconds: number;
    lastUpdated: Date | number | string;

    constructor(id: number | string, projectId: number | string, text: string, start: Date | number | string, end: Date | number | string,
        duration: number, lastUpdated: Date | number | string) {
        this.id = id;
        this.projectId = projectId;
        this.text = text;
        this.start = start;
        this.end = end;
        this.durationInMilliseconds = duration;
        this.lastUpdated = lastUpdated;
    }
}