import {Error} from "../models/error";

export class ErrorService {
    static readonly redmineServiceName = "Redmine";
    static readonly togglServiceName = "Toggl";

    private createError(exception: any, serviceName: string): Error {
        const error = new Error();

        error.exception = exception;
        error.service = serviceName;

        return error;
    }

    public createRedmineError(exception: any): Error {
       return this.createError(exception, ErrorService.redmineServiceName);
    }

    public createTogglError(exception: any): Error {
        return this.createError(exception, ErrorService.togglServiceName)
    }

    public createRedmineCantBeSecondaryError(): Error {
        return this.createError("Redmine is meant to be primary.", ErrorService.redmineServiceName)
    }
}