import { ObjectId } from "mongodb";
import { databaseService } from "../shared/database_service";
import {Timer2TicketError} from "./timer2TicketError";
import {Connection} from "./connection/connection";

export class JobLog {
  // Mongo
  _id!: string | ObjectId;

  // UserId
  userId: string | ObjectId;
  connectionId!: ObjectId;
  userConnectionId!: number;

  connectionBetween!: string;

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
  errors: Array<Timer2TicketError>;

  constructor(connection:Connection, type: string, origin: string) {
    this.userId = connection.userId;
    this.connectionId = connection._id;
    this.userConnectionId = connection.userConnectionId;
    this.connectionBetween = Connection.getConnectionBetweenString(connection);

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
  static async setToRunning(jobLog: JobLog): Promise<JobLog | null> {
    if (jobLog.status !== 'scheduled') {
      return null;
    }

    jobLog.status = 'running';
    jobLog.started = new Date().getTime();
    return await databaseService.updateJobLog(jobLog);
  }

  /**
   * Sets the status of this object to '(un)successful' + sets completed to now.
   * Also makes changes to the DB.
   * @param isSuccessful flag if job was successful. Default true.
   * @returns Promise<JobLog> DB object if update operation was successful. Else Promise<null>.
   */
  static async setToCompleted(jobLog: JobLog, isSuccessful = true): Promise<JobLog | null> {
    if (jobLog.status !== 'running') {
      return null;
    }

    jobLog.status = isSuccessful ? 'successful' : 'unsuccessful';
    jobLog.completed = new Date().getTime();
    return await databaseService.updateJobLog(jobLog);
  }
}