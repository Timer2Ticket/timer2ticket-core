import {Timer2ticketError} from "../models/timer2ticketError";

export class ErrorService {
    static readonly redmineServiceName = "Redmine";
    static readonly togglServiceName = "Toggl";

    public createError(exception: any, serviceName: string): Timer2ticketError {
        const error = new Timer2ticketError();

        error.exception = exception;
        error.service = serviceName;

        return error;
    }

    public createRedmineError(exception: any): Timer2ticketError {
       return this.createError(exception, ErrorService.redmineServiceName);
    }

    public createTogglError(exception: any): Timer2ticketError {
        return this.createError(exception, ErrorService.togglServiceName)
    }

    public createRedmineCantBeSecondaryError(): Timer2ticketError {
        return this.createError("Redmine is meant to be primary.", ErrorService.redmineServiceName)
    }
}