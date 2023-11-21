import { JobLog } from "../models/job_log";
import { User } from "../models/user/user";
import { SentryService } from "../shared/sentry_service";
import { ErrorService } from "../shared/error_service";
import { Connection } from "../models/connection/connection";
import { SyncedServiceDefinition } from "../models/connection/config/synced_service_definition";

export abstract class SyncJob {
    protected _user: User;
    protected _connection: Connection;
    protected _serviceDefinitions: SyncedServiceDefinition[];
    protected _jobLog: JobLog;
    protected _sentryService;
    protected _errorService;

    constructor(user: User, connection: Connection, jobLog: JobLog) {
        this._user = user;
        this._connection = connection;
        this._jobLog = jobLog;
        this._sentryService = new SentryService();
        this._errorService = new ErrorService();
        this._serviceDefinitions = [this._connection.firstService, this._connection.secondService];
    }

    /**
     * Used for Sentry error logging
     */
    get userId(): string {
        return this._connection.userId.toHexString();
    }

    async start(): Promise<boolean> {
        JobLog.setToRunning(this._jobLog);
        let result
        try {
            result = await this._doTheJob();
        } catch (ex: any) {
            console.log(ex)
            return false
        }
        JobLog.setToCompleted(this._jobLog, result);
        return result;
    }

    /**
     * Does the job, returns true if successfully done, false otherwise and needs to be repeated
     */
    protected abstract _doTheJob(): Promise<boolean>;
}