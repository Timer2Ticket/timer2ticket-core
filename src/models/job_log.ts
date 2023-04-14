import { ObjectId } from "mongodb";
import { databaseService } from "../shared/database_service";
import {Error} from "./error";

export class Joblog {
  _id!: string | ObjectId;
  userId: string | ObjectId;
  // type: 'config' | 'time-entries'
  type: string;
  // origin: 't2t-auto' | 'manual'
  origin: string;
  // status: 'scheduled' | 'running' | 'successful' | 'unsuccessful'
  status: string;
  scheduledDate: number;
  started: number | null;
  completed: number | null;
  // currently not used
  errors: Array<Error>;

  constructor(userId: string | ObjectId, type: string, origin: string) {
    this.userId = userId;
    this.type = type;
    this.origin = origin;

    this.status = 'scheduled';
    this.scheduledDate = new Date().getTime();
    this.started = null;
    this.completed = null;
    this.errors = [];
  }

  /**
   * Sets the status of this object to 'running' + sets started to now.
   * Also makes changes to the DB.
   * @returns Promise<JobLog> DB object if update operation was successful. Else Promise<null>.
   */
  async setToRunning(): Promise<Joblog | null> {
    if (this.status !== 'scheduled') {
      return null;
    }

    this.status = 'running';
    this.started = new Date().getTime();
    return await databaseService.updateJobLog(this);
  }

  /**
   * Sets the status of this object to '(un)successful' + sets completed to now.
   * Also makes changes to the DB.
   * @param isSuccessful flag if job was successful. Default true.
   * @returns Promise<JobLog> DB object if update operation was successful. Else Promise<null>.
   */
  async setToCompleted(isSuccessful = true): Promise<Joblog | null> {
    if (this.status !== 'running') {
      return null;
    }

    this.status = isSuccessful ? 'successful' : 'unsuccessful';
    this.completed = new Date().getTime();
    return await databaseService.updateJobLog(this);
  }
}