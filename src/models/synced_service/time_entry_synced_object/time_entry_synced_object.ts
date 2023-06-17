import { ObjectId } from "mongodb";
import { Utilities } from "../../../shared/utilities";
import { ServiceTimeEntryObject } from "./service_time_entry_object";

export class TimeEntrySyncedObject {
  _id!: string | ObjectId;
  connectionId: string | ObjectId;
  lastUpdated: number;
  date: Date | undefined;
  serviceTimeEntryObjects: ServiceTimeEntryObject[];
  archived?: boolean;

  constructor(connectionId: string | ObjectId, date: string | number | Date) {
    this.connectionId = connectionId;
    this.lastUpdated = Date.now();
    this.date = new Date(Utilities.getOnlyDateString(new Date(date)));
    this.serviceTimeEntryObjects = [];
  }
}