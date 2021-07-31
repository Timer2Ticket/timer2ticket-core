import { JobLog } from "../models/jobLog";
import { User } from "../models/user";

export abstract class SyncJob {
  protected _user: User;
  private _jobLog: JobLog;

  constructor(user: User, jobLog: JobLog) {
    this._user = user;
    this._jobLog = jobLog;
  }

  /**
   * Used for Sentry error logging
   */
  get userId(): string {
    return this._user._id.toString();
  }

  async start(): Promise<boolean> {
    this._jobLog.setToRunning();
    const result = await this._doTheJob();
    this._jobLog.setToCompleted(result);
    return result;
  }

  /**
   * Does the job, returns true if successfully done, false otherwise and needs to be repeated
   */
  protected abstract _doTheJob(): Promise<boolean>;
}