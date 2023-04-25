import { JobLog } from "../models/job_log";
import { User } from "../models/user";
import {SentryService} from "../shared/sentry_service";
import {ErrorService} from "../shared/error_service";

export abstract class SyncJob {
  protected _user: User;
  protected _jobLog: JobLog;
  protected _sentryService;
  protected _errorService;

  constructor(user: User, jobLog: JobLog) {
    this._user = user;
    this._jobLog = jobLog;
    this._sentryService = new SentryService();
    this._errorService = new ErrorService();
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